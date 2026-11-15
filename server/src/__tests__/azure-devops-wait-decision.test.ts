import { describe, expect, it } from "vitest";
import type { AdoComment, AdoPrSnapshot, AdoThread } from "../services/azure-devops-wait-client.js";
import {
  decideWait,
  gateWake,
  type AdoWaitConfig,
  type WaitSubject,
  type WakeHistory,
} from "../services/azure-devops-wait-decision.js";

const ref = {
  host: "dev.azure.com" as const,
  organization: "pharao2k",
  project: "NME",
  repository: "NME-IaC",
  number: 7,
};
const BOT = "bot@pharao2k.example";
const NICO = "nico@example.com";
const config: AdoWaitConfig = { reviewerOrgs: ["pharao2k"], agentIdentities: { pharao2k: BOT } };
const noHistory: WakeHistory = { sweepWakesSinceReset24h: 0, lastSweepWakeAt: null, quotaPausedUntil: null };
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = new Date("2026-11-14T12:00:00.000Z");
const minAgo = (m: number) => iso(NOW.getTime() - m * 60_000);

const monitor: WaitSubject = { source: "monitor", issueId: "i1", target: { kind: "pr", ref } };
const card = (cardCreatedAt: string): WaitSubject => ({ source: "merge_card", issueId: "i2", ref, cardCreatedAt });

function comment(over: Partial<AdoComment> = {}): AdoComment {
  return {
    authorUniqueName: NICO,
    parentCommentId: 0,
    commentType: "text",
    publishedAt: minAgo(60),
    lastUpdatedAt: minAgo(60),
    ...over,
  };
}
const thread = (comments: AdoComment[], vote: AdoThread["vote"] = null): AdoThread => ({ id: 1, comments, vote });
const voteThread = (value: number, at: string, uniqueName = NICO): AdoThread =>
  thread([comment({ commentType: "system", authorUniqueName: uniqueName, publishedAt: at, lastUpdatedAt: at })], {
    uniqueName,
    value,
    at,
  });

function pr(over: Partial<AdoPrSnapshot> = {}): AdoPrSnapshot {
  return {
    status: "active",
    lastMergeSourceCommit: "src2",
    lastMergeCommit: "mrg2",
    lastPushAt: minAgo(60),
    evaluations: [
      { status: "approved", isExpired: false, buildId: 1, buildSourceSha: "src2", buildSourceVersion: null },
    ],
    hasBuildPolicy: true,
    threads: [thread([comment({ authorUniqueName: BOT, publishedAt: minAgo(30), lastUpdatedAt: minAgo(30) })])],
    ...over,
  };
}

function run(input: {
  subject?: WaitSubject;
  pr?: AdoPrSnapshot | null;
  build?: Parameters<typeof decideWait>[0]["build"];
  history?: WakeHistory;
  pending?: boolean;
  nextCheck?: string | null;
  now?: Date;
  delivered?: Parameters<typeof decideWait>[0]["delivered"];
  mergeCard?: boolean;
}) {
  return decideWait({
    subject: input.subject ?? monitor,
    pr: input.pr,
    build: input.build,
    history: input.history ?? noHistory,
    config,
    organization: "pharao2k",
    monitorPendingForSamePr: input.pending ?? false,
    monitorNextCheckAt: input.nextCheck ?? null,
    now: input.now ?? NOW,
    delivered: input.delivered,
    mergeCardPendingForSamePr: input.mergeCard,
  });
}

describe("azure devops wait decision", () => {
  it("fires when build evaluations are approved for the current source commit and the AI review is in", () => {
    const d = run({ pr: pr() });
    expect(d).toMatchObject({ action: "wake", reason: "validation_and_review_final" });
    if (d.action === "wake") expect(d.summary.length).toBeLessThanOrEqual(200);
  });

  it("does not fire while an evaluation points at an older commit's build", () => {
    const p = pr({
      evaluations: [{ status: "approved", isExpired: false, buildId: 1, buildSourceSha: "src1", buildSourceVersion: null }],
    });
    expect(run({ pr: p })).toEqual({ action: "none" });
  });

  it("matches by merge commit when the build has no pr.sourceSha", () => {
    const ok = pr({
      evaluations: [{ status: "approved", isExpired: false, buildId: 1, buildSourceSha: null, buildSourceVersion: "mrg2" }],
    });
    expect(run({ pr: ok }).action).toBe("wake");
    const stale = pr({
      evaluations: [{ status: "approved", isExpired: false, buildId: 1, buildSourceSha: null, buildSourceVersion: "mrg1" }],
    });
    expect(run({ pr: stale }).action).toBe("none");
  });

  it("treats notApplicable without a build as final", () => {
    const p = pr({
      evaluations: [{ status: "notApplicable", isExpired: false, buildId: null, buildSourceSha: null, buildSourceVersion: null }],
    });
    expect(run({ pr: p }).action).toBe("wake");
  });

  it("treats isExpired as final", () => {
    const p = pr({
      evaluations: [{ status: "queued", isExpired: true, buildId: 1, buildSourceSha: "src1", buildSourceVersion: null }],
    });
    expect(run({ pr: p }).action).toBe("wake");
  });

  it("needs a known absent build policy to treat zero evaluations as final", () => {
    expect(run({ pr: pr({ evaluations: [], hasBuildPolicy: null }) })).toEqual({ action: "none" });
    expect(run({ pr: pr({ evaluations: [], hasBuildPolicy: false }) }).action).toBe("wake");
  });

  it("waits for the AI review until 30 minutes after the push", () => {
    const base = { threads: [] as AdoThread[] };
    expect(run({ pr: pr({ ...base, lastPushAt: minAgo(29) }) })).toEqual({ action: "none" });
    expect(run({ pr: pr({ ...base, lastPushAt: minAgo(30) }) }).action).toBe("wake");
  });

  it("counts an updated top-level bot comment as the review", () => {
    const p = pr({
      lastPushAt: minAgo(10),
      threads: [thread([comment({ authorUniqueName: BOT, publishedAt: minAgo(120), lastUpdatedAt: minAgo(5) })])],
    });
    expect(run({ pr: p }).action).toBe("wake");
  });

  it("does not count Nicolas's top-level comment as the AI review", () => {
    const p = pr({
      lastPushAt: minAgo(10),
      threads: [thread([comment({ authorUniqueName: NICO, publishedAt: minAgo(5), lastUpdatedAt: minAgo(5) })])],
    });
    expect(run({ pr: p })).toEqual({ action: "none" });
  });

  it("wakes on a closed PR", () => {
    expect(run({ pr: pr({ status: "completed", evaluations: [], hasBuildPolicy: null }) })).toMatchObject({
      action: "wake",
      reason: "pr_closed",
    });
    expect(run({ pr: pr({ status: "abandoned" }) })).toMatchObject({ action: "wake", reason: "pr_closed" });
  });

  it("ignores bot replies and system comments as PR activity", () => {
    const p = pr({
      threads: [
        thread([
          comment({ publishedAt: minAgo(300), lastUpdatedAt: minAgo(300) }),
          comment({ authorUniqueName: BOT, parentCommentId: 1, publishedAt: minAgo(20), lastUpdatedAt: minAgo(20) }),
          comment({ commentType: "system", authorUniqueName: NICO, parentCommentId: 1, publishedAt: minAgo(20), lastUpdatedAt: minAgo(20) }),
        ]),
      ],
    });
    expect(run({ subject: card(minAgo(200)), pr: p })).toEqual({ action: "none" });
    const human = pr({
      threads: [
        thread([
          comment({ publishedAt: minAgo(300), lastUpdatedAt: minAgo(300) }),
          comment({ authorUniqueName: NICO, parentCommentId: 1, publishedAt: minAgo(20), lastUpdatedAt: minAgo(20) }),
        ]),
      ],
    });
    expect(run({ subject: card(minAgo(200)), pr: human })).toMatchObject({ action: "wake", reason: "pr_activity" });
  });

  it("a standing wait-for-author vote wakes once", () => {
    const p = pr({ threads: [voteThread(-5, minAgo(120))] });
    expect(run({ subject: card(minAgo(300)), pr: p }).action).toBe("wake");
    const afterWake: WakeHistory = { ...noHistory, lastSweepWakeAt: minAgo(60) };
    expect(run({ subject: card(minAgo(300)), pr: p, history: afterWake })).toEqual({ action: "none" });
  });

  it("counts a reject vote but not an approve vote", () => {
    expect(run({ subject: card(minAgo(300)), pr: pr({ threads: [voteThread(-10, minAgo(60))] }) }).action).toBe("wake");
    expect(run({ subject: card(minAgo(300)), pr: pr({ threads: [voteThread(10, minAgo(60))] }) }).action).toBe("none");
  });

  it("holds PR activity during the 10-minute quiet period", () => {
    const p = pr({ threads: [voteThread(-10, minAgo(3))] });
    expect(run({ subject: card(minAgo(300)), pr: p })).toEqual({ action: "hold", reason: "quiet_period" });
  });

  it("defers merge-card activity to a pending wait monitor on the same PR", () => {
    const p = pr({ threads: [voteThread(-10, minAgo(60))] });
    expect(run({ subject: card(minAgo(300)), pr: p, pending: true })).toEqual({ action: "none" });
  });

  it("ignores merge-card activity on a completed PR", () => {
    const p = pr({ status: "completed", threads: [voteThread(-10, minAgo(60))] });
    expect(run({ subject: card(minAgo(300)), pr: p })).toEqual({ action: "none" });
  });

  it("pauses at 6 sweep wakes", () => {
    const history: WakeHistory = { ...noHistory, sweepWakesSinceReset24h: 6 };
    expect(gateWake(history, NOW)).toBe("cap");
    expect(run({ pr: pr(), history })).toEqual({ action: "pause", pendingEvent: "validation_and_review_final" });
    expect(run({ pr: pr({ evaluations: [], hasBuildPolicy: null }), history })).toEqual({ action: "none" });
  });

  it("holds during a quota pause and wakes on the first tick after it", () => {
    const history: WakeHistory = { ...noHistory, quotaPausedUntil: iso(NOW.getTime() + 60_000) };
    expect(run({ pr: pr(), history })).toEqual({ action: "hold", reason: "quota" });
    expect(run({ pr: pr(), history, now: new Date(NOW.getTime() + 61_000) }).action).toBe("wake");
  });

  it("extends the backstop only when it is less than 48 h away", () => {
    const build = { status: "inProgress" as const, result: null, waitingOnApproval: true };
    const buildSubject: WaitSubject = {
      source: "monitor",
      issueId: "i3",
      target: { kind: "build", organization: "pharao2k", project: "NME", buildId: 4690 },
    };
    const soon = iso(NOW.getTime() + 47 * 3_600_000);
    const far = iso(NOW.getTime() + 49 * 3_600_000);
    expect(run({ subject: buildSubject, build, nextCheck: soon })).toEqual({ action: "extend_backstop" });
    expect(run({ subject: buildSubject, build, nextCheck: far })).toEqual({ action: "none" });
    const done = { status: "completed" as const, result: "succeeded", waitingOnApproval: false };
    expect(run({ subject: buildSubject, build: done })).toMatchObject({ action: "wake", reason: "pipeline_finished" });
  });

  it("does not re-fire a wait on an unchanged final PR", () => {
    expect(run({ pr: pr() })).toMatchObject({ action: "wake", reason: "validation_and_review_final", identity: "src2" });
    expect(run({ pr: pr(), delivered: { validation_and_review_final: "src2" } })).toEqual({ action: "none" });
    const closed = pr({ status: "completed" });
    expect(run({ pr: closed })).toMatchObject({ action: "wake", reason: "pr_closed", identity: "completed" });
    expect(run({ pr: closed, delivered: { pr_closed: "completed" } })).toEqual({ action: "none" });
    expect(run({ pr: closed, delivered: { validation_and_review_final: "src2" } })).toMatchObject({ action: "wake", reason: "pr_closed" });
  });

  it("fires again after a new push changes the source commit", () => {
    expect(run({ pr: pr(), delivered: { validation_and_review_final: "src1" } })).toMatchObject({
      action: "wake",
      reason: "validation_and_review_final",
      identity: "src2",
    });
  });

  it("does not re-fire on the same finished build", () => {
    const done = { status: "completed" as const, result: "succeeded", waitingOnApproval: false };
    const subject = (buildId: number): WaitSubject => ({
      source: "monitor",
      issueId: "i3",
      target: { kind: "build", organization: "pharao2k", project: "NME", buildId },
    });
    expect(run({ subject: subject(4690), build: done })).toMatchObject({ action: "wake", reason: "pipeline_finished", identity: "4690" });
    expect(run({ subject: subject(4690), build: done, delivered: { pipeline_finished: "4690" } })).toEqual({ action: "none" });
    expect(run({ subject: subject(4691), build: done, delivered: { pipeline_finished: "4690" } }).action).toBe("wake");
  });

  it("holds validation_and_review_final while a merge card on the same PR is pending", () => {
    expect(run({ pr: pr(), mergeCard: true })).toEqual({ action: "none" });
    // A completed PR is reported by the merge sweep as merge_accepted; an abandoned one still wakes.
    expect(run({ pr: pr({ status: "completed" }), mergeCard: true })).toEqual({ action: "none" });
    expect(run({ pr: pr({ status: "abandoned" }), mergeCard: true })).toMatchObject({ action: "wake", reason: "pr_closed" });
  });

  it("never fires on an unknown snapshot", () => {
    expect(run({ pr: null })).toEqual({ action: "none" });
    expect(run({ pr: undefined })).toEqual({ action: "none" });
    expect(run({ subject: card(minAgo(300)), pr: null })).toEqual({ action: "none" });
    const buildSubject: WaitSubject = {
      source: "monitor",
      issueId: "i3",
      target: { kind: "build", organization: "pharao2k", project: "NME", buildId: 1 },
    };
    expect(run({ subject: buildSubject, build: null })).toEqual({ action: "none" });
  });
});
