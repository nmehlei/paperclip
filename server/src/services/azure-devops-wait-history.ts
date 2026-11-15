import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
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
