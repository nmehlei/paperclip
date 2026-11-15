import { and, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  issueThreadInteractions,
  issues,
  toolActionRequests,
  type Db,
} from "@paperclipai/db";
import { conflict, HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import {
  DEFAULT_AZURE_DEVOPS_TOKEN_SECRET_NAMES,
  azureDevOpsOrganizationSecretName,
  type AzureDevOpsPullRequestReference,
} from "./azure-devops-pull-request-merge.js";
import {
  createAdoWaitClient,
  parseAdoWaitTarget,
  type AdoBuildSnapshot,
  type AdoPrSnapshot,
  type AdoWaitTarget,
} from "./azure-devops-wait-client.js";
import {
  BACKSTOP_MS,
  decideWait,
  type AdoWaitConfig,
  type WaitSubject,
} from "./azure-devops-wait-decision.js";
import {
  ADO_WAIT_ACTIVITY,
  ADO_WAIT_ACTOR_ID,
  withIssueWakeReservation,
} from "./azure-devops-wait-history.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { prepareIssueMonitorUpdate } from "./issue-monitors.js";
import { getMergeConfirmationPullRequestReferences } from "./issue-thread-interactions.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";

export const ADO_WAIT_SERVICE_NAME = "nme_ado_wait";

const BACKSTOP_TIMEOUT_MS = 7 * 24 * 3600_000;
const PAUSED_MESSAGE = "Automatic wakes paused: limit reached. Reply on the issue to resume.";
const CLOSED_STATUSES = ["done", "cancelled"];

type AdoWaitClient = Pick<ReturnType<typeof createAdoWaitClient>, "pr" | "build" | "probe">;

export type TriggerIssueMonitor = (
  issueId: string,
  input: { actorType: "system"; actorId: string },
) => Promise<{ outcome: string }>;

export type UpdateIssueMonitor = (
  issueId: string,
  change: { nextCheckAt: string; timeoutAt: string },
) => Promise<void>;

export type AdoWaitWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_commented";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    allowRunCoalescing?: boolean;
    requestedByActorType: "system";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<unknown>;

export function adoWaitSweepDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NME_ADO_WAIT_SWEEP?.trim().toLowerCase() === "off";
}

export function loadAdoWaitConfig(env: NodeJS.ProcessEnv = process.env): AdoWaitConfig {
  const reviewerOrgs = (env.NME_ADO_REVIEWER_ORGS ?? "pharao2k")
    .split(",")
    .map((org) => org.trim())
    .filter(Boolean);
  const agentIdentities: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(env.NME_ADO_AGENT_IDENTITIES ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [org, name] of Object.entries(parsed)) {
        if (typeof name === "string" && name.trim()) agentIdentities[org.toLowerCase()] = name.trim();
      }
    }
  } catch {
    logger.warn("NME_ADO_AGENT_IDENTITIES is not valid JSON; ignoring it");
  }
  return { reviewerOrgs, agentIdentities };
}

/**
 * Stored monitor externalRefs are redacted by the write path, so the link normally comes
 * from the notes: the last Azure DevOps PR or build URL outside any `Event:` line.
 */
export function resolveAdoWaitTarget(externalRef: unknown, notes: unknown): AdoWaitTarget | null {
  if (typeof externalRef === "string") {
    const direct = parseAdoWaitTarget(externalRef);
    if (direct) return direct;
  }
  if (typeof notes !== "string") return null;
  let found: AdoWaitTarget | null = null;
  for (const line of notes.split("\n")) {
    if (line.trimStart().startsWith("Event:")) continue;
    for (const match of line.matchAll(/https:\/\/\S+/g)) {
      const url = match[0].replace(/[.,;:!?)\]}>'"]+$/, "");
      const target = parseAdoWaitTarget(url);
      if (target) found = target;
    }
  }
  return found;
}

function targetLink(target: AdoWaitTarget) {
  const e = encodeURIComponent;
  if (target.kind === "build") {
    return `https://dev.azure.com/${e(target.organization)}/${e(target.project)}/_build/results?buildId=${target.buildId}`;
  }
  const r = target.ref;
  return `https://dev.azure.com/${e(r.organization)}/${e(r.project)}/_git/${e(r.repository)}/pullrequest/${r.number}`;
}

function prKey(ref: AzureDevOpsPullRequestReference) {
  return `${ref.organization}/${ref.project}/${ref.repository}#${ref.number}`.toLowerCase();
}

type CandidateOutcome =
  | { action: "wake"; summary: string }
  | { action: "pause" | "extend" | "hold" | "none" };

type Candidate = {
  issueId: string;
  companyId: string;
  agentId: string;
  subject: WaitSubject;
  organization: string;
  link: string;
  monitorNextCheckAt: string | null;
  monitorPendingForSamePr: boolean;
};

async function loadCandidates(db: Db): Promise<Candidate[]> {
  const assignable = and(
    isNotNull(issues.assigneeAgentId),
    isNull(issues.assigneeUserId),
    notInArray(issues.status, CLOSED_STATUSES),
  );
  const monitorRows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      agentId: issues.assigneeAgentId,
      executionPolicy: issues.executionPolicy,
      monitorNotes: issues.monitorNotes,
      monitorNextCheckAt: issues.monitorNextCheckAt,
    })
    .from(issues)
    .where(and(
      assignable,
      isNotNull(issues.monitorNextCheckAt),
      sql`${issues.executionPolicy} -> 'monitor' ->> 'serviceName' = ${ADO_WAIT_SERVICE_NAME}`,
    ));

  const candidates: Candidate[] = [];
  const monitorPrs = new Map<string, Set<string>>();
  for (const row of monitorRows) {
    const monitor = (row.executionPolicy as { monitor?: Record<string, unknown> } | null)?.monitor ?? {};
    const target = resolveAdoWaitTarget(monitor.externalRef, monitor.notes ?? row.monitorNotes);
    if (!target || !row.agentId) continue;
    if (target.kind === "pr") {
      const set = monitorPrs.get(row.id) ?? new Set<string>();
      set.add(prKey(target.ref));
      monitorPrs.set(row.id, set);
    }
    candidates.push({
      issueId: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      subject: { source: "monitor", issueId: row.id, target },
      organization: target.kind === "pr" ? target.ref.organization : target.organization,
      link: targetLink(target),
      monitorNextCheckAt: row.monitorNextCheckAt?.toISOString() ?? null,
      monitorPendingForSamePr: false,
    });
  }

  // Same selection as the merged-PR confirmation sweep, limited to Azure DevOps links.
  const cardRows = await db
    .select({
      interaction: issueThreadInteractions,
      issue: { id: issues.id, companyId: issues.companyId, agentId: issues.assigneeAgentId },
    })
    .from(issueThreadInteractions)
    .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
    .where(and(
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "pending"),
      assignable,
    ));
  const cards = cardRows.flatMap((row) => {
    const refs = getMergeConfirmationPullRequestReferences(row.interaction).filter(
      (ref): ref is AzureDevOpsPullRequestReference => ref.host === "dev.azure.com",
    );
    return refs.length > 0 && row.issue.agentId ? [{ ...row, refs, agentId: row.issue.agentId }] : [];
  });
  if (cards.length > 0) {
    const linked = await db
      .select({ interactionId: toolActionRequests.interactionId })
      .from(toolActionRequests)
      .where(inArray(toolActionRequests.interactionId, cards.map((c) => c.interaction.id)));
    const governed = new Set(linked.map((row) => row.interactionId));
    for (const card of cards) {
      if (governed.has(card.interaction.id)) continue;
      for (const ref of card.refs) {
        candidates.push({
          issueId: card.issue.id,
          companyId: card.issue.companyId,
          agentId: card.agentId,
          subject: {
            source: "merge_card",
            issueId: card.issue.id,
            ref,
            cardCreatedAt: card.interaction.createdAt.toISOString(),
          },
          organization: ref.organization,
          link: targetLink({ kind: "pr", ref }),
          monitorNextCheckAt: null,
          monitorPendingForSamePr: monitorPrs.get(card.issue.id)?.has(prKey(ref)) ?? false,
        });
      }
    }
  }
  return candidates;
}

/** Lock + prepareIssueMonitorUpdate + write, as the runner tool's set_task_monitor does, as system actor. */
export function adoWaitMonitorUpdater(db: Db): UpdateIssueMonitor {
  return async (issueId, change) => {
    const publications: ActivityPublication[] = [];
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      if (!issue) throw notFound("Issue not found");
      const current = normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor;
      if (!current || current.serviceName !== ADO_WAIT_SERVICE_NAME) throw conflict("Wait monitor changed");
      const { scheduledBy, ...rest } = current;
      const patch = prepareIssueMonitorUpdate(
        issue,
        { ...rest, notes: rest.notes ?? "Azure DevOps wait", ...change } as Parameters<typeof prepareIssueMonitorUpdate>[1],
        scheduledBy === "board" ? { type: "board" } : { type: "agent", agentId: issue.assigneeAgentId },
      );
      // Keep a server-written raw externalRef; normalization would redact it.
      const rawRef = (issue.executionPolicy as { monitor?: { externalRef?: unknown } } | null)?.monitor?.externalRef;
      const stored = patch.executionPolicy as { monitor?: Record<string, unknown> } | null | undefined;
      if (typeof rawRef === "string" && stored?.monitor) stored.monitor = { ...stored.monitor, externalRef: rawRef };
      await tx.update(issues).set({ ...patch, updatedAt: new Date() }).where(eq(issues.id, issueId));
      await logActivity(tx, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: ADO_WAIT_ACTOR_ID,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issueId,
        details: {
          identifier: issue.identifier,
          nextCheckAt: change.nextCheckAt,
          notes: rest.notes ?? null,
          scheduledBy,
          serviceName: rest.serviceName,
          timeoutAt: change.timeoutAt,
          maxAttempts: rest.maxAttempts ?? null,
          recoveryPolicy: rest.recoveryPolicy ?? null,
        },
      }, publications);
    });
    for (const publication of publications) publishActivity(publication);
  };
}

export function azureDevOpsWaitSweepService(
  db: Db,
  deps: {
    triggerIssueMonitor: TriggerIssueMonitor;
    updateIssueMonitor: UpdateIssueMonitor;
    wakeup: AdoWaitWakeup;
    client?: AdoWaitClient;
    config?: AdoWaitConfig;
    now?: () => Date;
  },
) {
  const client = deps.client ?? createAdoWaitClient(db);
  const now = deps.now ?? (() => new Date());
  const issuesSvc = issueService(db);

  async function readSnapshot(candidate: Candidate) {
    const s = candidate.subject;
    if (s.source === "merge_card") return { pr: await client.pr(candidate.companyId, s.ref) };
    if (s.target.kind === "pr") return { pr: await client.pr(candidate.companyId, s.target.ref) };
    return { build: await client.build(candidate.companyId, s.target) };
  }

  async function dispatch(candidate: Candidate, summary: string, activityAt: string | undefined): Promise<boolean> {
    if (candidate.subject.source === "monitor") {
      try {
        const result = await deps.triggerIssueMonitor(candidate.issueId, { actorType: "system", actorId: ADO_WAIT_ACTOR_ID });
        if (result.outcome === "triggered") return true;
        logger.debug({ issueId: candidate.issueId, outcome: result.outcome }, "azure devops wait monitor not triggered");
        return false;
      } catch (err) {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
          logger.debug({ issueId: candidate.issueId, status: err.status }, "azure devops wait monitor trigger refused");
          return false;
        }
        throw err;
      }
    }
    const result = await deps.wakeup(candidate.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: candidate.issueId, resolutionSource: "nme_ado_wait_sweep", summary },
      idempotencyKey: `nme_ado_wait:${candidate.issueId}:${activityAt ?? now().toISOString()}`,
      allowRunCoalescing: false,
      requestedByActorType: "system",
      requestedByActorId: ADO_WAIT_ACTOR_ID,
      contextSnapshot: {
        issueId: candidate.issueId,
        taskId: candidate.issueId,
        wakeReason: "issue_commented",
        source: "nme_ado_wait_sweep",
      },
    });
    return result != null;
  }

  async function processCandidate(candidate: Candidate, config: AdoWaitConfig) {
    const snapshot: { pr?: AdoPrSnapshot | null; build?: AdoBuildSnapshot | null } = await readSnapshot(candidate);
    const outcome = await withIssueWakeReservation<CandidateOutcome>(db, candidate.issueId, async (ctx) => {
      const decision = decideWait({
        subject: candidate.subject,
        pr: snapshot.pr,
        build: snapshot.build,
        history: ctx.history,
        config,
        organization: candidate.organization,
        monitorPendingForSamePr: candidate.monitorPendingForSamePr,
        monitorNextCheckAt: candidate.monitorNextCheckAt,
        now: ctx.now,
      });
      if (decision.action === "wake") {
        await ctx.reserve({ reason: decision.reason, link: candidate.link });
        const kept = await dispatch(candidate, decision.summary, decision.activityAt);
        return { keep: kept, value: { action: "wake" as const, summary: decision.summary } };
      }
      if (decision.action === "pause") {
        const since = ctx.history.lastSweepWakeAt ? new Date(ctx.history.lastSweepWakeAt) : new Date(0);
        const [existing] = await ctx.tx
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, ctx.companyId),
            eq(activityLog.action, ADO_WAIT_ACTIVITY.pause),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, candidate.issueId),
            gt(activityLog.createdAt, since),
          ))
          .orderBy(desc(activityLog.createdAt))
          .limit(1);
        if (!existing) await ctx.log(ADO_WAIT_ACTIVITY.pause, { message: PAUSED_MESSAGE, pendingEvent: decision.pendingEvent });
        return { keep: false, value: { action: "pause" as const } };
      }
      if (decision.action === "extend_backstop") {
        const nextCheckAt = new Date(ctx.now.getTime() + BACKSTOP_MS).toISOString();
        const timeoutAt = new Date(ctx.now.getTime() + BACKSTOP_TIMEOUT_MS).toISOString();
        await deps.updateIssueMonitor(candidate.issueId, { nextCheckAt, timeoutAt });
        await ctx.log(ADO_WAIT_ACTIVITY.extend, { nextCheckAt, timeoutAt, link: candidate.link });
        return { keep: false, value: { action: "extend" as const } };
      }
      return { keep: false, value: { action: decision.action } };
    }, { now: now() });
    if (outcome?.value.action === "wake" && outcome.kept) {
      // After commit: a failed comment never undoes the wake.
      await issuesSvc
        .addComment(candidate.issueId, `Event: ${outcome.value.summary}`, {}, { authorType: "system" })
        .catch((err: unknown) => logger.warn({ err, issueId: candidate.issueId }, "azure devops wait event comment failed"));
    }
    return outcome;
  }

  return {
    async sweep(): Promise<{ checked: number; woken: number; paused: number; extended: number }> {
      const result = { checked: 0, woken: 0, paused: 0, extended: 0 };
      if (adoWaitSweepDisabled()) return result;
      const config = deps.config ?? loadAdoWaitConfig();
      const candidates = await loadCandidates(db);
      for (const candidate of candidates) {
        result.checked += 1;
        try {
          const outcome = await processCandidate(candidate, config);
          if (!outcome) continue;
          if (outcome.value.action === "wake" && outcome.kept) result.woken += 1;
          if (outcome.value.action === "pause") result.paused += 1;
          if (outcome.value.action === "extend") result.extended += 1;
        } catch (err) {
          logger.warn({ err, issueId: candidate.issueId }, "azure devops wait sweep candidate failed");
        }
      }
      return result;
    },
  };
}

/** One-shot startup check that each organization's stored PAT can read builds and policies. Logs statuses only. */
export async function probeAzureDevOpsWaitOrganizations(
  db: Db,
  opts: { client?: AdoWaitClient; env?: NodeJS.ProcessEnv } = {},
): Promise<Array<{ org: string; builds: number; policies: number }>> {
  const env = opts.env ?? process.env;
  if (adoWaitSweepDisabled(env)) return [];
  const client = opts.client ?? createAdoWaitClient(db);
  const projects = new Map<string, { org: string; project: string; companyIds: Set<string> }>();
  for (const candidate of await loadCandidates(db)) {
    const s = candidate.subject;
    const project = s.source === "merge_card" ? s.ref.project : s.target.kind === "pr" ? s.target.ref.project : s.target.project;
    const key = candidate.organization.toLowerCase();
    const entry = projects.get(key) ?? { org: candidate.organization, project, companyIds: new Set<string>() };
    entry.companyIds.add(candidate.companyId);
    projects.set(key, entry);
  }
  try {
    const parsed: unknown = JSON.parse(env.NME_ADO_PROBE_PROJECTS ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [org, project] of Object.entries(parsed)) {
        if (typeof project !== "string" || !project.trim() || projects.has(org.toLowerCase())) continue;
        projects.set(org.toLowerCase(), { org, project: project.trim(), companyIds: new Set() });
      }
    }
  } catch {
    logger.warn("NME_ADO_PROBE_PROJECTS is not valid JSON; ignoring it");
  }
  if (projects.size === 0) return [];

  const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
  const secrets = secretService(db);
  const results: Array<{ org: string; builds: number; policies: number }> = [];
  for (const { org, project, companyIds } of projects.values()) {
    const names = [
      ...DEFAULT_AZURE_DEVOPS_TOKEN_SECRET_NAMES.map((name) => azureDevOpsOrganizationSecretName(name, org)),
      ...DEFAULT_AZURE_DEVOPS_TOKEN_SECRET_NAMES,
    ];
    const order = [...companyIds, ...activeCompanies.map((c) => c.id).filter((id) => !companyIds.has(id))];
    let companyId: string | null = null;
    for (const id of order) {
      for (const name of names) {
        if (await Promise.resolve(secrets.getByName(id, name)).catch(() => null)) {
          companyId = id;
          break;
        }
      }
      if (companyId) break;
    }
    if (!companyId) continue;
    const status = await client.probe(companyId, org, project);
    logger.info({ org, builds: status.builds, policies: status.policies }, "azure devops wait probe");
    results.push({ org, ...status });
  }
  return results;
}
