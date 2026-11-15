import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { AzureDevOpsPullRequestReference } from "./azure-devops-pull-request-merge.js";
import { adoPullRequestKey, resolveAdoWaitTarget } from "./azure-devops-wait-client.js";
import type { DeliveredWakes, WaitWakeReason, WakeHistory } from "./azure-devops-wait-decision.js";
import { buildIssueMonitorClearedPatch, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

export const ADO_WAIT_SERVICE_NAME = "nme_ado_wait";

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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A missing hour means midnight. */
function clockTime(rawHour: string | undefined, rawMinute: string | undefined, rawMeridiem: string | undefined) {
  if (rawHour === undefined) return { hour: 0, minute: 0 };
  let hour = Number(rawHour);
  const minute = rawMinute ? Number(rawMinute) : 0;
  const meridiem = rawMeridiem?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  if (minute > 59) return null;
  return { hour, minute };
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

  const dayTime = String.raw`(?:,?\s*(?:at\s+)?(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?)?`;

  const monthDay = new RegExp(
    String.raw`resets(?:\s+on)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b${dayTime}`,
    "i",
  ).exec(error);
  if (monthDay) {
    const month = MONTHS.indexOf(monthDay[1]!.slice(0, 3).toLowerCase());
    const day = Number(monthDay[2]);
    const time = clockTime(monthDay[3], monthDay[4], monthDay[5]);
    if (!time) return null;
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
      const candidate = new Date(year, month, day, time.hour, time.minute, 0, 0);
      if (candidate.getMonth() !== month || candidate.getDate() !== day) return null;
      if (candidate.getTime() > now.getTime()) return candidate;
    }
    return null;
  }

  const weekday = new RegExp(
    String.raw`resets(?:\s+on)?\s+(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\.?${dayTime}`,
    "i",
  ).exec(error);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1]!.slice(0, 3).toLowerCase());
    const time = clockTime(weekday[2], weekday[3], weekday[4]);
    if (!time) return null;
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0);
    candidate.setDate(candidate.getDate() + ((target - now.getDay() + 7) % 7));
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }

  const clock = /resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(error);
  if (clock) {
    const time = clockTime(clock[1], clock[2], clock[3]);
    if (!time) return null;
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0);
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

/**
 * The identity recorded on the newest wake entry per reason for one wait link (no time
 * window: a re-parked wait must not fire again on the same event days later).
 */
export async function loadDeliveredWakes(
  db: Db,
  companyId: string,
  issueId: string,
  link: string,
): Promise<DeliveredWakes> {
  const rows = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, ADO_WAIT_ACTIVITY.wake),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      sql`${activityLog.details} ->> 'link' = ${link}`,
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(50);
  const delivered: DeliveredWakes = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const details = (row.details ?? {}) as { reason?: unknown; identity?: unknown };
    if (typeof details.reason !== "string" || seen.has(details.reason)) continue;
    seen.add(details.reason);
    if (typeof details.identity === "string") delivered[details.reason as WaitWakeReason] = details.identity;
  }
  return delivered;
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

/**
 * After a merge-card acceptance wake: clears the issue's pending wait monitor when it waits on
 * one of the accepted PRs, so the wait sweep does not wake again with pr_closed. Same lock and
 * write shape as the monitor updater; runs in a savepoint so a failure never undoes the wake.
 * Call inside a reservation.
 */
export async function clearAdoWaitMonitorForPullRequests(
  ctx: WakeReservationContext,
  issueId: string,
  references: ReadonlyArray<{ host: string }>,
): Promise<boolean> {
  const keys = new Set(
    references
      .filter((ref): ref is AzureDevOpsPullRequestReference => ref.host === "dev.azure.com")
      .map(adoPullRequestKey),
  );
  if (keys.size === 0) return false;
  try {
    return await ctx.tx.transaction(async (rawSp) => {
      const sp = rawSp as unknown as Db;
      const [issue] = await sp.select().from(issues).where(eq(issues.id, issueId)).for("update");
      if (!issue?.monitorNextCheckAt) return false;
      const raw = (issue.executionPolicy as { monitor?: { serviceName?: unknown; externalRef?: unknown; notes?: unknown } } | null)
        ?.monitor;
      if (!raw || raw.serviceName !== ADO_WAIT_SERVICE_NAME) return false;
      const target = resolveAdoWaitTarget(raw.externalRef, raw.notes ?? issue.monitorNotes);
      if (target?.kind !== "pr" || !keys.has(adoPullRequestKey(target.ref))) return false;
      const patch = buildIssueMonitorClearedPatch({
        issue,
        policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
        clearReason: "manual",
        clearedAt: ctx.now,
      });
      await sp
        .update(issues)
        .set({
          ...patch,
          // Only the monitor belongs to us; keep the rest of the stored policy as it is.
          executionPolicy: sql`nullif(${issues.executionPolicy} - 'monitor', '{}'::jsonb)`,
          updatedAt: ctx.now,
        })
        .where(eq(issues.id, issueId));
      await ctx.log("issue.monitor_cleared", {
        identifier: issue.identifier,
        previousNextCheckAt: issue.monitorNextCheckAt.toISOString(),
        reason: "manual",
        source: "merge_accepted",
        notes: typeof raw.notes === "string" ? raw.notes : null,
      });
      return true;
    });
  } catch (err) {
    logger.warn({ err, issueId }, "azure devops wait monitor clear after merge failed");
    return false;
  }
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
