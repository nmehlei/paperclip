import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { WakeHistory } from "./azure-devops-wait-decision.js";

export const ADO_WAIT_ACTIVITY = {
  wake: "nme_ado_wait.wake",
  pause: "nme_ado_wait.paused",
  extend: "nme_ado_wait.extended",
} as const;

const DAY_MS = 24 * 3600_000;
const QUOTA_FALLBACK_MS = 5 * 3600_000;
const QUOTA_TEXT = /(5-hour|weekly|usage) limit|limit reached.*resets|You've hit your|cooling down/i;

export function isQuotaFailure(run: { status: string; errorCode?: string | null; error?: string | null }): boolean {
  if (run.errorCode === "provider_quota") return true;
  return run.status === "failed" && !!run.error && QUOTA_TEXT.test(run.error);
}

/** Zone-less times are interpreted in the server's local zone. */
export function parseQuotaReset(error: string | null, now: Date): Date | null {
  if (!error) return null;

  const iso = /resets(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(error);
  if (iso) {
    const parsed = new Date(iso[1].replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const relative = /(?:try again )?in\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i.exec(error);
  if (relative) {
    const unit = relative[2].toLowerCase().startsWith("h") ? 3600_000 : 60_000;
    return new Date(now.getTime() + Number(relative[1]) * unit);
  }

  const clock = /resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(error);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    } else if (hour > 23) {
      return null;
    }
    if (minute > 59) return null;
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  return null;
}

export async function loadWakeHistory(db: Db, companyId: string, issueId: string, now: Date): Promise<WakeHistory> {
  // Only a comment by a human board user resets the cap. Agent comments and
  // system notices (including the sweep's own) never do.
  const [lastHuman] = await db
    .select({ createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId),
      isNull(issueComments.deletedAt),
      sql`${issueComments.authorUserId} is not null`,
      isNull(issueComments.authorAgentId),
      isNull(issueComments.derivedAuthorAgentId),
      or(isNull(issueComments.authorType), eq(issueComments.authorType, "user")),
    ))
    .orderBy(desc(issueComments.createdAt))
    .limit(1);

  const windowStart = new Date(now.getTime() - DAY_MS);
  const since = lastHuman && lastHuman.createdAt > windowStart ? lastHuman.createdAt : windowStart;
  const wakes = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, ADO_WAIT_ACTIVITY.wake),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      gt(activityLog.createdAt, since),
    ))
    .orderBy(desc(activityLog.createdAt));

  // Runs link to an issue through the issue_id column; older rows only carry it
  // in the context snapshot. Two index-backed lookups (both lead with company_id),
  // newest by created_at wins.
  const runColumns = {
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    error: heartbeatRuns.error,
    finishedAt: heartbeatRuns.finishedAt,
    createdAt: heartbeatRuns.createdAt,
  };
  const [byColumn] = await db
    .select(runColumns)
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId)))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  const [bySnapshot] = await db
    .select(runColumns)
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${issueId}`,
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  const latestRun = byColumn && bySnapshot
    ? (bySnapshot.createdAt > byColumn.createdAt ? bySnapshot : byColumn)
    : (byColumn ?? bySnapshot);

  let quotaPausedUntil: string | null = null;
  if (latestRun && isQuotaFailure(latestRun)) {
    const reset = parseQuotaReset(latestRun.error, latestRun.finishedAt ?? now)
      ?? new Date((latestRun.finishedAt ?? now).getTime() + QUOTA_FALLBACK_MS);
    quotaPausedUntil = reset.toISOString();
  }

  return {
    sweepWakesSinceReset24h: wakes.length,
    lastSweepWakeAt: wakes[0]?.createdAt.toISOString() ?? null,
    quotaPausedUntil,
  };
}

export const ADO_WAIT_ACTOR_ID = "nme_ado_wait_sweep";

export type WakeReservationContext = {
  /** The transaction holding the per-issue advisory lock. */
  tx: Db;
  companyId: string;
  history: WakeHistory;
  now: Date;
  /** Insert the nme_ado_wait.wake entry (counts immediately for any concurrent reader after commit). */
  reserve: (details: Record<string, unknown>) => Promise<void>;
  /** Log another activity entry on the transaction; published after commit. */
  log: (action: string, details: Record<string, unknown>) => Promise<void>;
};

/**
 * Serializes wake decisions per issue. The callback gates and dispatches while the lock
 * is held; return keep=false when the dispatch did not happen (skipped), and the reserved
 * wake entry is deleted in the same transaction. A throw rolls everything back.
 * Returns null when the issue does not exist.
 */
export async function withIssueWakeReservation<T>(
  db: Db,
  issueId: string,
  fn: (ctx: WakeReservationContext) => Promise<{ keep: boolean; value: T }>,
  opts: { now?: Date } = {},
): Promise<{ kept: boolean; reserved: boolean; value: T } | null> {
  const publications: ActivityPublication[] = [];
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`nme_ado_wait:${issueId}`}))`);
    const [issue] = await tx
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) return null;
    const now = opts.now ?? new Date();
    const history = await loadWakeHistory(tx, issue.companyId, issueId, now);
    let reservedId: string | null = null;
    let reservedPublication: ActivityPublication | null = null;
    const write = async (action: string, details: Record<string, unknown>, into: ActivityPublication[]) =>
      logActivity(tx, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: ADO_WAIT_ACTOR_ID,
        action,
        entityType: "issue",
        entityId: issueId,
        details,
      }, into);
    const ctx: WakeReservationContext = {
      tx,
      companyId: issue.companyId,
      history,
      now,
      reserve: async (details) => {
        if (reservedId) throw new Error("wake already reserved");
        const pending: ActivityPublication[] = [];
        reservedId = (await write(ADO_WAIT_ACTIVITY.wake, details, pending)).id;
        reservedPublication = pending[0] ?? null;
      },
      log: async (action, details) => {
        await write(action, details, publications);
      },
    };
    const result = await fn(ctx);
    if (reservedId && !result.keep) {
      await tx.delete(activityLog).where(eq(activityLog.id, reservedId));
    } else if (reservedId && reservedPublication) {
      publications.push(reservedPublication);
    }
    return { kept: result.keep, reserved: reservedId !== null, value: result.value };
  });
  for (const publication of publications) publishActivity(publication);
  return outcome;
}

export const PAUSED_MESSAGE = "Automatic wakes paused: limit reached. Reply on the issue to resume.";

export function adoWaitSweepDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NME_ADO_WAIT_SWEEP?.trim().toLowerCase() === "off";
}

/** Logs the paused entry unless one is already newer than the last wake. Call inside a reservation. */
export async function logPausedOnce(
  ctx: WakeReservationContext,
  issueId: string,
  pendingEvent: string,
): Promise<void> {
  const since = ctx.history.lastSweepWakeAt ? new Date(ctx.history.lastSweepWakeAt) : new Date(0);
  const [existing] = await ctx.tx
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, ctx.companyId),
      eq(activityLog.action, ADO_WAIT_ACTIVITY.pause),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      gt(activityLog.createdAt, since),
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  if (!existing) await ctx.log(ADO_WAIT_ACTIVITY.pause, { message: PAUSED_MESSAGE, pendingEvent });
}
