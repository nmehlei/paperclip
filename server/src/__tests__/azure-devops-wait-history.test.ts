import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  ADO_WAIT_ACTIVITY,
  isQuotaFailure,
  loadWakeHistory,
  parseQuotaReset,
} from "../services/azure-devops-wait-history.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("isQuotaFailure", () => {
  it("is true for provider quota wording and the provider_quota code", () => {
    expect(isQuotaFailure({ status: "failed", error: "5-hour limit reached ∙ resets 3pm" })).toBe(true);
    expect(isQuotaFailure({ status: "failed", errorCode: "provider_quota" })).toBe(true);
    expect(isQuotaFailure({ status: "succeeded", errorCode: "provider_quota" })).toBe(true);
  });

  it("is false for unrelated failures", () => {
    expect(isQuotaFailure({ status: "failed", error: "Process killed: out of memory (OOM)" })).toBe(false);
    expect(isQuotaFailure({ status: "failed", error: "Azure DevOps returned 429" })).toBe(false);
    expect(isQuotaFailure({ status: "succeeded", error: "5-hour limit reached" })).toBe(false);
  });
});

// Zone-less times use the server's local zone, so expectations are built with
// local-time Date constructors and are independent of the machine's TZ.
describe("parseQuotaReset", () => {
  const now = new Date(2026, 10, 14, 12, 0, 0);

  it("parses a time of day later today", () => {
    expect(parseQuotaReset("5-hour limit reached ∙ resets 3pm", now)).toEqual(new Date(2026, 10, 14, 15, 0, 0));
  });

  it("parses a time of day already passed as tomorrow", () => {
    const late = new Date(2026, 10, 14, 16, 0, 0);
    expect(parseQuotaReset("limit reached, resets 3pm", late)).toEqual(new Date(2026, 10, 15, 15, 0, 0));
  });

  it("parses an explicit ISO timestamp with a zone", () => {
    expect(parseQuotaReset("usage limit, resets at 2026-11-14T15:00:00Z", now)?.toISOString()).toBe(
      "2026-11-14T15:00:00.000Z",
    );
  });

  it("parses a zone-less timestamp in the server's zone", () => {
    expect(parseQuotaReset("resets at 2026-11-14T15:30:00", now)).toEqual(new Date(2026, 10, 14, 15, 30, 0));
  });

  it("parses a relative duration", () => {
    expect(parseQuotaReset("try again in 2 hours", now)).toEqual(new Date(now.getTime() + 2 * 3600_000));
    expect(parseQuotaReset("try again in 45 minutes", now)).toEqual(new Date(now.getTime() + 45 * 60_000));
  });

  it("returns null when nothing parses", () => {
    expect(parseQuotaReset(null, now)).toBeNull();
    expect(parseQuotaReset("something broke", now)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("loadWakeHistory", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ado-wait-history-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${Math.floor(Math.random() * 1e6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wait for ADO",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, issueId, agentId };
  }

  const wake = (companyId: string, issueId: string, createdAt: Date, entityId = issueId) => ({
    companyId,
    actorType: "system",
    actorId: "nme-ado-wait",
    action: ADO_WAIT_ACTIVITY.wake,
    entityType: "issue",
    entityId,
    createdAt,
  });

  it("counts wakes since the latest human comment and ignores old, foreign and non-human ones", async () => {
    const { companyId, issueId, agentId } = await seed();
    const other = await seed();
    const now = new Date("2026-11-14T12:00:00Z");
    const h = (hours: number) => new Date(now.getTime() - hours * 3600_000);

    await db.insert(activityLog).values([
      wake(companyId, issueId, h(30)),
      wake(companyId, issueId, h(10)),
      wake(companyId, issueId, h(2)),
      wake(other.companyId, other.issueId, h(1)),
      { ...wake(companyId, issueId, h(1)), action: ADO_WAIT_ACTIVITY.pause },
    ]);
    await db.insert(issueComments).values([
      { companyId, issueId, authorUserId: "board-user", authorType: "user", body: "go", createdAt: h(12) },
      // agent and system comments must not reset the count
      { companyId, issueId, authorAgentId: agentId, authorType: "agent", body: "ok", createdAt: h(1.5) },
      { companyId, issueId, authorType: "system", body: "sweep note", createdAt: h(1.2) },
    ]);

    // other-company rows that reuse this issue id must be ignored
    await db.insert(activityLog).values(wake(other.companyId, issueId, h(1)));
    await db.insert(issueComments).values({
      companyId: other.companyId, issueId: other.issueId, authorUserId: "u", authorType: "user", body: "x", createdAt: h(0.5),
    });

    const history = await loadWakeHistory(db, companyId, issueId, now);
    expect(history.sweepWakesSinceReset24h).toBe(2);
    expect(history.lastSweepWakeAt).toBe(h(2).toISOString());
    expect(history.quotaPausedUntil).toBeNull();

    // a user comment between the two remaining wakes leaves one
    await db.insert(issueComments).values({
      companyId, issueId, authorUserId: "board-user", authorType: "user", body: "again", createdAt: h(5),
    });
    const after = await loadWakeHistory(db, companyId, issueId, now);
    expect(after.sweepWakesSinceReset24h).toBe(1);
  });

  it("derives quotaPausedUntil from the latest run on the issue", async () => {
    const { companyId, issueId, agentId } = await seed();
    const now = new Date("2026-11-14T12:00:00Z");
    await db.insert(heartbeatRuns).values([
      {
        companyId, agentId, issueId, scopeKind: "issue", status: "failed",
        errorCode: "provider_quota", error: "try again in 2 hours",
        finishedAt: new Date("2026-11-14T11:00:00Z"),
        createdAt: new Date("2026-11-14T10:00:00Z"),
      },
      {
        companyId, agentId, issueId, scopeKind: "issue", status: "failed",
        errorCode: "provider_quota", error: "no reset info",
        finishedAt: new Date("2026-11-14T11:30:00Z"),
        createdAt: new Date("2026-11-14T11:00:00Z"),
      },
    ]);
    // a newer quota failure of another company on the same issue id is ignored
    const other = await seed();
    await db.insert(heartbeatRuns).values({
      companyId: other.companyId, agentId: other.agentId, issueId: other.issueId, scopeKind: "issue",
      contextSnapshot: { issueId }, status: "succeeded", finishedAt: new Date("2026-11-14T11:55:00Z"), createdAt: new Date("2026-11-14T11:55:00Z"),
    });
    const history = await loadWakeHistory(db, companyId, issueId, now);
    // latest run has no parsable reset: finishedAt + 5 h
    expect(history.quotaPausedUntil).toBe("2026-11-14T16:30:00.000Z");
  });

  it("reports no quota pause when the latest run is healthy", async () => {
    const { companyId, issueId, agentId } = await seed();
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, issueId, scopeKind: "issue", status: "failed", errorCode: "provider_quota",
        finishedAt: new Date("2026-11-14T09:00:00Z"), createdAt: new Date("2026-11-14T09:00:00Z") },
      { companyId, agentId, issueId, scopeKind: "issue", status: "succeeded",
        finishedAt: new Date("2026-11-14T10:00:00Z"), createdAt: new Date("2026-11-14T10:00:00Z") },
    ]);
    const history = await loadWakeHistory(db, companyId, issueId, new Date("2026-11-14T12:00:00Z"));
    expect(history.quotaPausedUntil).toBeNull();
  });
});
