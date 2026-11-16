import type { AzureDevOpsPullRequestReference } from "./azure-devops-pull-request-merge.js";
import type {
  AdoBuildSnapshot,
  AdoPrSnapshot,
  AdoWaitTarget,
} from "./azure-devops-wait-client.js";

export const WAKE_CAP_24H = 6;
export const PR_QUIET_MS = 600_000;
export const AI_REVIEW_FALLBACK_MS = 1_800_000;
export const QUOTA_DEFAULT_PAUSE_MS = 18_000_000;
export const BACKSTOP_MS = 259_200_000;
export const BACKSTOP_REFRESH_BELOW_MS = 172_800_000;

export type WaitSubject =
  | { source: "monitor"; issueId: string; target: AdoWaitTarget }
  | { source: "merge_card"; issueId: string; ref: AzureDevOpsPullRequestReference; cardCreatedAt: string };

export type WakeHistory = {
  sweepWakesSinceReset24h: number;
  lastSweepWakeAt: string | null;
  quotaPausedUntil: string | null;
};

export type AdoWaitConfig = { reviewerOrgs: string[]; agentIdentities: Record<string, string> };

export type WaitWakeReason =
  | "validation_and_review_final"
  | "pr_closed"
  | "pr_activity"
  | "pipeline_finished";

export type WaitDecision =
  | {
      action: "wake";
      reason: WaitWakeReason;
      summary: string;
      activityAt?: string;
      /** Monitor wakes: what was delivered (source commit|policy build ids, PR status, build id@finishTime); stored on the wake entry. */
      identity?: string;
    }
  | { action: "pause"; pendingEvent: WaitWakeReason }
  | { action: "extend_backstop" }
  | { action: "hold"; reason: "quota" | "quiet_period" }
  | { action: "none" };

/** Identity of the newest delivered wake per reason for one wait link. */
export type DeliveredWakes = Partial<Record<WaitWakeReason, string>>;

export function gateWake(history: WakeHistory, now: Date): "ok" | "quota" | "cap" {
  if (history.quotaPausedUntil) {
    const until = Date.parse(history.quotaPausedUntil);
    if (Number.isFinite(until) && until > now.getTime()) return "quota";
  }
  if (history.sweepWakesSinceReset24h >= WAKE_CAP_24H) return "cap";
  return "ok";
}

const FINAL_STATUSES = new Set(["approved", "rejected", "broken", "notApplicable"]);
const NONE: WaitDecision = { action: "none" };

function ms(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function summarize(text: string) {
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

function prUrl(ref: AzureDevOpsPullRequestReference) {
  return `https://dev.azure.com/${encodeURIComponent(ref.organization)}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repository)}/pullrequest/${ref.number}`;
}

function buildUrl(organization: string, project: string, buildId: number) {
  return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_build/results?buildId=${buildId}`;
}

function identityFor(config: AdoWaitConfig, organization: string): string | null {
  const wanted = organization.toLowerCase();
  for (const [org, name] of Object.entries(config.agentIdentities)) {
    if (org.toLowerCase() === wanted && name) return name.toLowerCase();
  }
  return null;
}

function validationFinal(pr: AdoPrSnapshot): boolean {
  if (pr.evaluations.length === 0) return pr.hasBuildPolicy === false;
  return pr.evaluations.every((e) => {
    if (e.isExpired) return true;
    if (!FINAL_STATUSES.has(e.status)) return false;
    if (e.status === "notApplicable" || e.buildId === null) return true;
    if (e.buildSourceSha !== null) return e.buildSourceSha === pr.lastMergeSourceCommit;
    return e.buildSourceVersion !== null && e.buildSourceVersion === pr.lastMergeCommit;
  });
}

function policyBuildIds(pr: AdoPrSnapshot): string {
  return pr.evaluations
    .map((e) => e.buildId)
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b)
    .join(",");
}

function aiReviewIn(pr: AdoPrSnapshot, config: AdoWaitConfig, organization: string, now: Date): boolean {
  const org = organization.toLowerCase();
  if (!config.reviewerOrgs.some((o) => o.toLowerCase() === org)) return true;
  const push = ms(pr.lastPushAt);
  if (Number.isFinite(push) && now.getTime() - push >= AI_REVIEW_FALLBACK_MS) return true;
  const identity = identityFor(config, organization);
  if (!identity) return false;
  return pr.threads.some((t) =>
    t.comments.some(
      (c) =>
        c.parentCommentId === 0 &&
        c.commentType === "text" &&
        c.authorUniqueName.toLowerCase() === identity &&
        (!Number.isFinite(push) || Math.max(ms(c.publishedAt), ms(c.lastUpdatedAt)) > push),
    ),
  );
}

/** Newest counted activity time (ms) after the baseline, or null. */
function newestActivity(pr: AdoPrSnapshot, identity: string | null, baseline: number): number | null {
  let newest: number | null = null;
  const bump = (t: number) => {
    if (Number.isFinite(t) && t > baseline && (newest === null || t > newest)) newest = t;
  };
  for (const thread of pr.threads) {
    for (const c of thread.comments) {
      if (c.commentType !== "text") continue;
      if (c.parentCommentId === 0) {
        bump(ms(c.publishedAt));
        bump(ms(c.lastUpdatedAt));
      } else if (identity !== null && c.authorUniqueName.toLowerCase() !== identity) {
        bump(ms(c.publishedAt));
      }
    }
    const v = thread.vote;
    if (v && v.value <= -5 && v.uniqueName.toLowerCase() !== identity) bump(ms(v.at));
  }
  return newest;
}

function gate(event: WaitDecision & { action: "wake" }, history: WakeHistory, now: Date): WaitDecision {
  const g = gateWake(history, now);
  if (g === "quota") return { action: "hold", reason: "quota" };
  if (g === "cap") return { action: "pause", pendingEvent: event.reason };
  return event;
}

export function decideWait(input: {
  subject: WaitSubject;
  pr?: AdoPrSnapshot | null;
  build?: AdoBuildSnapshot | null;
  history: WakeHistory;
  config: AdoWaitConfig;
  organization: string;
  monitorNextCheckAt: string | null;
  now: Date;
  /** Monitor subjects: the event already delivered for this link, so a re-parked wait does not fire again. */
  delivered?: DeliveredWakes;
  /**
   * Monitor subjects: a pending merge card on the same PR means the PR is already handed over;
   * the card's sweep owns review activity and the merge, the monitor is held.
   */
  mergeCardPendingForSamePr?: boolean;
}): WaitDecision {
  const { subject, history, config, organization, now } = input;
  const delivered = input.delivered ?? {};
  const fire = (event: WaitDecision & { action: "wake" }): WaitDecision =>
    event.identity !== undefined && delivered[event.reason] === event.identity ? NONE : gate(event, history, now);

  if (subject.source === "merge_card") {
    const pr = input.pr;
    if (!pr) return NONE;
    if (pr.status !== "active") return NONE;
    const baseline = Math.max(ms(subject.cardCreatedAt) || 0, ms(history.lastSweepWakeAt) || 0);
    const newest = newestActivity(pr, identityFor(config, organization), baseline);
    if (newest === null) return NONE;
    if (now.getTime() - newest < PR_QUIET_MS) return { action: "hold", reason: "quiet_period" };
    return gate(
      {
        action: "wake",
        reason: "pr_activity",
        activityAt: new Date(newest).toISOString(),
        summary: summarize(`New review activity on PR ${subject.ref.number}. ${prUrl(subject.ref)}`),
      },
      history,
      now,
    );
  }

  const target = subject.target;
  if (target.kind === "pr") {
    const pr = input.pr;
    if (!pr) return NONE;
    if (pr.status === "completed" || pr.status === "abandoned") {
      // The merge sweep accepts the pending card and wakes with merge_accepted.
      if (pr.status === "completed" && input.mergeCardPendingForSamePr) return NONE;
      return fire({
        action: "wake",
        reason: "pr_closed",
        identity: pr.status,
        summary: summarize(`PR ${target.ref.number} ${pr.status}. ${prUrl(target.ref)}`),
      });
    }
    if (input.mergeCardPendingForSamePr) return NONE;
    if (validationFinal(pr) && aiReviewIn(pr, config, organization, now)) {
      return fire({
        action: "wake",
        reason: "validation_and_review_final",
        // A requeued policy build on the same commit is a new event.
        ...(pr.lastMergeSourceCommit ? { identity: `${pr.lastMergeSourceCommit}|${policyBuildIds(pr)}` } : {}),
        summary: summarize(`PR ${target.ref.number} validation and AI review are final. ${prUrl(target.ref)}`),
      });
    }
    return NONE;
  }

  const build = input.build;
  if (!build) return NONE;
  if (build.status === "completed") {
    return fire({
      action: "wake",
      reason: "pipeline_finished",
      // A "retry failed stages" run keeps the build id; its finish time changes.
      identity: `${target.buildId}@${build.finishTime ?? ""}`,
      summary: summarize(
        `Build ${target.buildId} finished: ${build.result ?? "unknown"}. ${buildUrl(target.organization, target.project, target.buildId)}`,
      ),
    });
  }
  if (build.waitingOnApproval) {
    const next = ms(input.monitorNextCheckAt);
    if (Number.isFinite(next) && next < now.getTime() + BACKSTOP_REFRESH_BELOW_MS) return { action: "extend_backstop" };
  }
  return NONE;
}
