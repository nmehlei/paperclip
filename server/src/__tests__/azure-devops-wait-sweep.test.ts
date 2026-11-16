import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { AdoBuildSnapshot, AdoPrSnapshot } from "../services/azure-devops-wait-client.js";
import { ADO_WAIT_ACTIVITY } from "../services/azure-devops-wait-history.js";
import {
  adoWaitMonitorUpdater,
  azureDevOpsWaitSweepService,
} from "../services/azure-devops-wait-sweep.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createHeartbeatScheduling, type HeartbeatSchedulingDependencies } from "../services/heartbeat/scheduling.js";
import { prepareIssueMonitorUpdate } from "../services/issue-monitors.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn(), subscribeAllCompanyLiveEvents: vi.fn() }));

const HOUR = 3600_000;
const PR_URL = "https://dev.azure.com/pharao2k/NME-IaC/_git/NME-IaC/pullrequest/42";
const BUILD_URL = (id: number) => `https://dev.azure.com/pharao2k/NME-IaC/_build/results?buildId=${id}`;
const config = { reviewerOrgs: [], agentIdentities: {} };

function finalPr(overrides: Partial<AdoPrSnapshot> = {}): AdoPrSnapshot {
  return {
    status: "active",
    lastMergeSourceCommit: "abc",
    lastMergeCommit: "def",
    lastPushAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    evaluations: [{ status: "approved", isExpired: false, buildId: null, buildSourceSha: null, buildSourceVersion: null }],
    hasBuildPolicy: true,
    threads: [],
    ...overrides,
  };
}

const FINISHED_AT = "2026-11-14T11:00:00.000Z";
const finishedBuild: AdoBuildSnapshot = { status: "completed", result: "succeeded", waitingOnApproval: false, finishTime: FINISHED_AT };

function fakeClient(opts: { pr?: AdoPrSnapshot | null; build?: AdoBuildSnapshot | null } = {}) {
  return {
    pr: vi.fn(async () => (opts.pr === undefined ? finalPr() : opts.pr)),
    build: vi.fn(async () => (opts.build === undefined ? finishedBuild : opts.build)),
    probe: vi.fn(async () => ({ builds: 200, policies: 200 })),
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("azure devops wait sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ado-wait-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(issuePatch: Partial<typeof issues.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "NME", issuePrefix: `W${Math.floor(Math.random() * 1e6)}` }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Jarvis", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const issue = await addIssue(company!.id, agent!.id, issuePatch);
    return { companyId: company!.id, agentId: agent!.id, issueId: issue.id };
  }

  async function addIssue(companyId: string, agentId: string | null, patch: Partial<typeof issues.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({
      companyId, title: "Land the change", status: "in_review", priority: "medium",
      assigneeAgentId: agentId, ...patch,
    }).returning();
    return issue!;
  }

  /** Parks a wait the way the agent does: through the monitor write path, so externalRef is redacted. */
  async function setMonitor(issueId: string, input: { link: string; notes?: string; serviceName?: string; nextCheckAt?: Date }) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const nextCheckAt = input.nextCheckAt ?? new Date(Date.now() + 72 * HOUR);
    const patch = prepareIssueMonitorUpdate(issue!, {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: input.notes ?? `Waiting on CI ${input.link}`,
      kind: "external_service",
      serviceName: input.serviceName ?? "nme_ado_wait",
      externalRef: input.link,
      timeoutAt: new Date(nextCheckAt.getTime() + 96 * HOUR).toISOString(),
      maxAttempts: null,
      recoveryPolicy: "wake_owner",
    } as never, { type: "agent", agentId: issue!.assigneeAgentId });
    await db.update(issues).set(patch).where(eq(issues.id, issueId));
  }

  async function addWakes(companyId: string, issueId: string, count: number) {
    for (let i = 0; i < count; i += 1) {
      await db.insert(activityLog).values({
        companyId, actorType: "system", actorId: "nme_ado_wait_sweep", action: ADO_WAIT_ACTIVITY.wake,
        entityType: "issue", entityId: issueId, details: { reason: "pipeline_finished" },
        createdAt: new Date(Date.now() - (count - i) * 60_000),
      });
    }
  }

  async function activity(issueId: string, action: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
  }

  async function eventComments(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  function spies() {
    return {
      triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
      wakeup: vi.fn(async () => ({ id: randomUUID() })),
    };
  }

  function service(deps: ReturnType<typeof spies>, client: ReturnType<typeof fakeClient>) {
    return azureDevOpsWaitSweepService(db, {
      ...deps,
      updateIssueMonitor: adoWaitMonitorUpdater(db),
      client,
      config,
    });
  }

  it("wakes through the monitor with the event in its notes when the PR is final", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    const deps = spies();
    const result = await service(deps, fakeClient()).sweep();

    expect(result).toEqual({ checked: 1, woken: 1, paused: 0, extended: 0 });
    expect(deps.triggerIssueMonitor).toHaveBeenCalledWith(f.issueId, { actorType: "system", actorId: "nme_ado_wait_sweep" });
    const wakes = await activity(f.issueId, ADO_WAIT_ACTIVITY.wake);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.details).toMatchObject({ reason: "validation_and_review_final", link: PR_URL });
    const comments = await eventComments(f.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toBe(`Event: PR 42 validation and AI review are final. ${PR_URL}`);
  });

  it("reads the wait link from the notes when externalRef is redacted", async () => {
    const f = await seed();
    await setMonitor(f.issueId, {
      link: BUILD_URL(7),
      notes: `Deploy run ${BUILD_URL(6)} superseded by ${BUILD_URL(7)}.\nEvent: Build 5 finished: failed. ${BUILD_URL(5)}`,
    });
    const [stored] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect((stored!.executionPolicy as { monitor: { externalRef: string } }).monitor.externalRef).toBe("[redacted]");
    const client = fakeClient();
    const deps = spies();
    const result = await service(deps, client).sweep();

    expect(result.woken).toBe(1);
    expect(client.build).toHaveBeenCalledWith(f.companyId, {
      kind: "build", organization: "pharao2k", project: "NME-IaC", buildId: 7,
    });
  });

  it("posts one Event comment per kept wake and none for a skipped one", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: BUILD_URL(4690) });
    const deps = spies();
    deps.triggerIssueMonitor.mockResolvedValueOnce({ outcome: "skipped" } as never);
    const sweep = service(deps, fakeClient());

    await sweep.sweep();
    expect(await eventComments(f.issueId)).toHaveLength(0);
    await sweep.sweep();
    const comments = await eventComments(f.issueId);
    expect(comments.map((c) => c.body)).toEqual([`Event: Build 4690 finished: succeeded. ${BUILD_URL(4690)}`]);
  });

  it("does not re-fire a re-parked wait on the same finished build", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: BUILD_URL(4700) });
    const deps = spies();
    const sweep = service(deps, fakeClient());

    expect((await sweep.sweep()).woken).toBe(1);
    const [wake] = await activity(f.issueId, ADO_WAIT_ACTIVITY.wake);
    expect(wake!.details).toEqual({ reason: "pipeline_finished", link: BUILD_URL(4700), identity: `4700@${FINISHED_AT}` });
    await setMonitor(f.issueId, { link: BUILD_URL(4700) });
    expect(await sweep.sweep()).toEqual({ checked: 1, woken: 0, paused: 0, extended: 0 });
    expect(deps.triggerIssueMonitor).toHaveBeenCalledTimes(1);
    expect(await eventComments(f.issueId)).toHaveLength(1);
  });

  it("re-fires a PR wait only after a new push changes the source commit", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    let pr = finalPr({ lastMergeSourceCommit: "c1" });
    const client = fakeClient();
    client.pr.mockImplementation(async () => pr);
    const deps = spies();
    const sweep = service(deps, client);

    expect((await sweep.sweep()).woken).toBe(1);
    expect((await sweep.sweep()).woken).toBe(0);
    pr = finalPr({ lastMergeSourceCommit: "c2" });
    expect((await sweep.sweep()).woken).toBe(1);
    const wakes = await activity(f.issueId, ADO_WAIT_ACTIVITY.wake);
    expect(wakes.map((w) => (w.details as { identity: string }).identity).sort()).toEqual(["c1|", "c2|"]);
  });

  it("holds a final PR wait while a merge card on the same PR is pending", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee_on_accept", requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only", title: `Merge ${PR_URL}?`,
      payload: { version: 1, prompt: "Merge the PR?" },
    });
    const deps = spies();
    const result = await service(deps, fakeClient()).sweep();

    expect(result.woken).toBe(0);
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(0);
  });

  it("counts only triggered monitor wakes", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: BUILD_URL(1) });
    const deps = spies();
    deps.triggerIssueMonitor.mockResolvedValue({ outcome: "skipped" } as never);
    const result = await service(deps, fakeClient()).sweep();

    expect(result).toEqual({ checked: 1, woken: 0, paused: 0, extended: 0 });
    expect(deps.triggerIssueMonitor).toHaveBeenCalledTimes(1);
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(0);
  });

  it("two waits in a row on one issue both fire", async () => {
    const f = await seed();
    const state = createHeartbeatRunState(db);
    const preparation = createHeartbeatRunPreparation(db);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as typeof heartbeatRuns.$inferSelect);
    const scheduler = createHeartbeatScheduling(db, {
      getAgent: state.getAgent,
      getRun: state.getRun,
      toAgentOrgRow: preparation.toAgentOrgRow,
      groupAgentOrgRowsByCompany: preparation.groupAgentOrgRowsByCompany,
      issuesSvc: { listReviewAttention: vi.fn(async () => new Map()), create: vi.fn() } as never,
      enqueueWakeup: enqueueWakeup as never,
      scheduleBoundedRetryForRun: vi.fn() as never,
      getSchedulingSuppression: vi.fn(async () => ({ suppressed: false })),
      getWorktreeExecutionCutoff: vi.fn(async () => null),
      parseHeartbeatPolicy: vi.fn() as never,
      claimDueTimerHeartbeat: vi.fn() as never,
    } satisfies HeartbeatSchedulingDependencies);
    let build: AdoBuildSnapshot = finishedBuild;
    const client = fakeClient();
    client.build.mockImplementation(async () => build);
    const sweep = azureDevOpsWaitSweepService(db, {
      triggerIssueMonitor: scheduler.triggerIssueMonitor,
      updateIssueMonitor: adoWaitMonitorUpdater(db),
      wakeup: vi.fn(),
      client,
      config,
    });

    await setMonitor(f.issueId, { link: BUILD_URL(1) });
    expect((await sweep.sweep()).woken).toBe(1);
    let [row] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row!.monitorNextCheckAt).toBeNull();

    await setMonitor(f.issueId, { link: BUILD_URL(2) });
    expect((await sweep.sweep()).woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);

    build = { status: "inProgress", result: null, waitingOnApproval: true, finishTime: null };
    await setMonitor(f.issueId, { link: BUILD_URL(3), nextCheckAt: new Date(Date.now() + HOUR) });
    expect((await sweep.sweep()).extended).toBe(1);
    [row] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row!.monitorNextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 71 * HOUR);
    expect(row!.monitorAttemptCount).toBe(2);
  });

  it("wakes via wakeup for merge-card PR activity and logs one wake", async () => {
    const f = await seed();
    const activityAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee_on_accept", requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only", title: `Merge ${PR_URL}?`,
      payload: { version: 1, prompt: "Merge the PR?" }, createdAt: new Date(Date.now() - 2 * HOUR),
    });
    const client = fakeClient({
      pr: finalPr({
        threads: [{
          id: 1, vote: null,
          comments: [{ authorUniqueName: "nicolas@example.com", parentCommentId: 0, commentType: "text", publishedAt: activityAt, lastUpdatedAt: activityAt }],
        }],
      }),
    });
    const deps = spies();
    const sweep = service(deps, client);

    expect((await sweep.sweep()).woken).toBe(1);
    expect(await sweep.sweep()).toMatchObject({ woken: 0 });
    expect(deps.wakeup).toHaveBeenCalledTimes(1);
    expect(deps.wakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: expect.objectContaining({ issueId: f.issueId, resolutionSource: "nme_ado_wait_sweep" }),
      idempotencyKey: `nme_ado_wait:${f.issueId}:${activityAt}`,
      allowRunCoalescing: false,
    }));
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(1);
    expect(await eventComments(f.issueId)).toHaveLength(1);
  });

  it("does not hold a PR wait for a pending card that also names another PR", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    const otherPr = PR_URL.replace(/42$/, "43");
    await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee_on_accept", requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only", title: `Merge ${PR_URL} and ${otherPr}?`,
      payload: { version: 1, prompt: "Merge both PRs?" },
    });
    const deps = spies();
    await service(deps, fakeClient()).sweep();

    expect(deps.triggerIssueMonitor).toHaveBeenCalledTimes(1);
    const wakes = await activity(f.issueId, ADO_WAIT_ACTIVITY.wake);
    expect(wakes.map((w) => (w.details as { reason: string }).reason)).toEqual(["validation_and_review_final"]);
  });

  it("wakes once for review activity with a wait monitor and a pending merge card on the same PR", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    const activityAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee_on_accept", requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only", title: `Merge ${PR_URL}?`,
      payload: { version: 1, prompt: "Merge the PR?" }, createdAt: new Date(Date.now() - 2 * HOUR),
    });
    const client = fakeClient({
      pr: finalPr({
        threads: [{
          id: 1, vote: null,
          comments: [{ authorUniqueName: "nicolas@example.com", parentCommentId: 0, commentType: "text", publishedAt: activityAt, lastUpdatedAt: activityAt }],
        }],
      }),
    });
    const deps = spies();
    const result = await service(deps, client).sweep();

    expect(result).toMatchObject({ checked: 2, woken: 1 });
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
    expect(deps.wakeup).toHaveBeenCalledTimes(1);
    const wakes = await activity(f.issueId, ADO_WAIT_ACTIVITY.wake);
    expect(wakes.map((w) => (w.details as { reason: string }).reason)).toEqual(["pr_activity"]);
  });

  it("skips a merge-card wake when the card or the assignee changed after the candidate load", async () => {
    const f = await seed();
    const other = await db.insert(agents).values({
      companyId: f.companyId, name: "Marco", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const activityAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const [card] = await db.insert(issueThreadInteractions).values({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee_on_accept", requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only", title: `Merge ${PR_URL}?`,
      payload: { version: 1, prompt: "Merge the PR?" }, createdAt: new Date(Date.now() - 2 * HOUR),
    }).returning();
    const pr = finalPr({
      threads: [{
        id: 1, vote: null,
        comments: [{ authorUniqueName: "nicolas@example.com", parentCommentId: 0, commentType: "text", publishedAt: activityAt, lastUpdatedAt: activityAt }],
      }],
    });
    const changes: Array<() => Promise<unknown>> = [
      () => db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, card!.id)),
      () => db.update(issues).set({ assigneeAgentId: other[0]!.id }).where(eq(issues.id, f.issueId)),
      () => db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "user-1" }).where(eq(issues.id, f.issueId)),
    ];
    for (const change of changes) {
      await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, card!.id));
      await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.issueId));
      const client = fakeClient();
      client.pr.mockImplementation(async () => {
        await change();
        return pr;
      });
      const deps = spies();
      expect(await service(deps, client).sweep()).toMatchObject({ checked: 1, woken: 0 });
      expect(deps.wakeup).not.toHaveBeenCalled();
    }
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(0);
    expect(await eventComments(f.issueId)).toHaveLength(0);
  });

  it("logs one paused entry, no comment and no wake at the cap", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: BUILD_URL(9) });
    await addWakes(f.companyId, f.issueId, 6);
    const deps = spies();
    const sweep = service(deps, fakeClient());

    expect(await sweep.sweep()).toEqual({ checked: 1, woken: 0, paused: 1, extended: 0 });
    await sweep.sweep();
    const paused = await activity(f.issueId, ADO_WAIT_ACTIVITY.pause);
    expect(paused).toHaveLength(1);
    expect(paused[0]!.details).toEqual({
      message: "Automatic wakes paused: limit reached. Reply on the issue to resume.",
      pendingEvent: "pipeline_finished",
    });
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
    expect(await eventComments(f.issueId)).toHaveLength(0);
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(6);
  });

  it("extends the backstop while the pipeline waits on approval", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: BUILD_URL(11), nextCheckAt: new Date(Date.now() + HOUR) });
    const deps = spies();
    const before = Date.now();
    const result = await service(deps, fakeClient({ build: { status: "inProgress", result: null, waitingOnApproval: true, finishTime: null } })).sweep();

    expect(result).toEqual({ checked: 1, woken: 0, paused: 0, extended: 1 });
    const [row] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row!.monitorNextCheckAt!.getTime()).toBeGreaterThanOrEqual(before + 72 * HOUR - 5_000);
    const monitor = (row!.executionPolicy as { monitor: { timeoutAt: string; serviceName: string; notes: string } }).monitor;
    expect(Date.parse(monitor.timeoutAt)).toBeGreaterThanOrEqual(before + 7 * 24 * HOUR - 5_000);
    expect(monitor.serviceName).toBe("nme_ado_wait");
    expect(monitor.notes).toContain(BUILD_URL(11));
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.extend)).toHaveLength(1);
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
  });

  it("skips issues assigned to a user, closed, todo or blocked, and survives a conflict", async () => {
    const f = await seed();
    const userIssue = await addIssue(f.companyId, f.agentId);
    const doneIssue = await addIssue(f.companyId, f.agentId);
    const todoIssue = await addIssue(f.companyId, f.agentId);
    const blockedIssue = await addIssue(f.companyId, f.agentId);
    const goodIssue = await addIssue(f.companyId, f.agentId, { status: "in_progress" });
    for (const id of [f.issueId, userIssue.id, doneIssue.id, todoIssue.id, blockedIssue.id, goodIssue.id]) {
      await setMonitor(id, { link: BUILD_URL(20) });
    }
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "user-1" }).where(eq(issues.id, userIssue.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, doneIssue.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, todoIssue.id));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, blockedIssue.id));
    const deps = spies();
    deps.triggerIssueMonitor.mockImplementation((async (issueId: string) => {
      if (issueId === f.issueId) throw conflict("Issue monitor check is already in progress");
      return { outcome: "triggered" as const };
    }) as never);
    const result = await service(deps, fakeClient()).sweep();

    expect(result).toMatchObject({ checked: 2, woken: 1 });
    expect(deps.triggerIssueMonitor.mock.calls.map((call) => (call as unknown[])[0]).sort()).toEqual([f.issueId, goodIssue.id].sort());
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(0);
    expect(await eventComments(f.issueId)).toHaveLength(0);
    expect(await activity(goodIssue.id, ADO_WAIT_ACTIVITY.wake)).toHaveLength(1);
  });

  it("ignores monitors with another serviceName or a non-ADO link", async () => {
    const f = await seed();
    const githubIssue = await addIssue(f.companyId, f.agentId);
    await setMonitor(f.issueId, { link: PR_URL, serviceName: "deploy_check" });
    await setMonitor(githubIssue.id, {
      link: "https://github.com/paperclipai/paperclip/pull/39",
      notes: "Waiting on https://github.com/paperclipai/paperclip/pull/39",
    });
    const client = fakeClient();
    const deps = spies();
    const result = await service(deps, client).sweep();

    expect(result).toEqual({ checked: 0, woken: 0, paused: 0, extended: 0 });
    expect(client.pr).not.toHaveBeenCalled();
    expect(client.build).not.toHaveBeenCalled();
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
  });

  it("treats an unknown build read as no event", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: BUILD_URL(30) });
    const deps = spies();
    const result = await service(deps, fakeClient({ build: null })).sweep();

    expect(result).toEqual({ checked: 1, woken: 0, paused: 0, extended: 0 });
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(0);
  });

  it("two concurrent sweeps on an issue with 5 wakes produce exactly one more wake", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    await addWakes(f.companyId, f.issueId, 5);
    const deps = spies();
    deps.triggerIssueMonitor.mockImplementation((async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { outcome: "triggered" as const };
    }) as never);
    // Each sweep reads a different source commit, so both see a new event and only the cap separates them.
    const client = fakeClient();
    client.pr
      .mockImplementationOnce(async () => finalPr({ lastMergeSourceCommit: "c1" }))
      .mockImplementationOnce(async () => finalPr({ lastMergeSourceCommit: "c2" }));
    const results = await Promise.all([service(deps, client).sweep(), service(deps, client).sweep()]);

    expect(client.pr).toHaveBeenCalledTimes(2);
    expect(results.reduce((sum, r) => sum + r.woken, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.paused, 0)).toBe(1);
    expect(deps.triggerIssueMonitor).toHaveBeenCalledTimes(1);
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.wake)).toHaveLength(6);
    expect(await activity(f.issueId, ADO_WAIT_ACTIVITY.pause)).toHaveLength(1);
  });

  it("does nothing when NME_ADO_WAIT_SWEEP is off", async () => {
    const f = await seed();
    await setMonitor(f.issueId, { link: PR_URL });
    vi.stubEnv("NME_ADO_WAIT_SWEEP", "off");
    const client = fakeClient();
    const deps = spies();
    const result = await service(deps, client).sweep();

    expect(result).toEqual({ checked: 0, woken: 0, paused: 0, extended: 0 });
    expect(client.pr).not.toHaveBeenCalled();
    expect(deps.triggerIssueMonitor).not.toHaveBeenCalled();
  });
});
