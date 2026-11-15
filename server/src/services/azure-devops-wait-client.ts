import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  createAzureDevOpsTokenProvider,
  extractAzureDevOpsPullRequestReferences,
  type AzureDevOpsPullRequestReference,
  type AzureDevOpsTokenProvider,
} from "./azure-devops-pull-request-merge.js";

export type AdoWaitTarget =
  | { kind: "pr"; ref: AzureDevOpsPullRequestReference }
  | { kind: "build"; organization: string; project: string; buildId: number };

export type AdoComment = {
  authorUniqueName: string;
  parentCommentId: number;
  commentType: string;
  publishedAt: string;
  lastUpdatedAt: string;
};

export type AdoThread = {
  id: number;
  comments: AdoComment[];
  vote: { uniqueName: string; value: number; at: string } | null;
};

export type AdoPolicyEvaluation = {
  status: string;
  isExpired: boolean;
  buildId: number | null;
  buildSourceSha: string | null;
  buildSourceVersion: string | null;
};

export type AdoPrSnapshot = {
  status: "active" | "completed" | "abandoned";
  lastMergeSourceCommit: string | null;
  lastMergeCommit: string | null;
  lastPushAt: string | null;
  evaluations: AdoPolicyEvaluation[];
  hasBuildPolicy: boolean | null;
  threads: AdoThread[];
};

export type AdoBuildSnapshot = {
  status: "completed" | "inProgress" | "notStarted";
  result: string | null;
  waitingOnApproval: boolean;
  /** Changes when a retry of the same build finishes again. */
  finishTime: string | null;
};

export const ADO_BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const LOG_INTERVAL_MS = 60 * 60_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseAdoWaitTarget(url: string): AdoWaitTarget | null {
  if (typeof url !== "string") return null;
  const prRef = extractAzureDevOpsPullRequestReferences([url])[0];
  if (prRef) return { kind: "pr", ref: prRef };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "dev.azure.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (segments.length !== 4 || segments[2] !== "_build" || segments[3] !== "results") return null;
  const raw = parsed.searchParams.get("buildId");
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const buildId = Number(raw);
  if (!Number.isSafeInteger(buildId)) return null;
  return { kind: "build", organization: segments[0]!, project: segments[1]!, buildId };
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

export function adoPullRequestKey(ref: AzureDevOpsPullRequestReference) {
  return `${ref.organization}/${ref.project}/${ref.repository}#${ref.number}`.toLowerCase();
}

function apiBase(organization: string, project: string) {
  return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis`;
}

export function createAdoWaitClient(
  db: Db,
  opts: { tokenProvider?: AzureDevOpsTokenProvider; fetch?: typeof fetch; now?: () => Date } = {},
) {
  const tokenProvider = opts.tokenProvider ?? createAzureDevOpsTokenProvider(db);
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const lastLogged = new Map<string, number>();
  const cache = new Map<string, { at: number; value: unknown }>();

  function logFailure(org: string, call: string, status: number) {
    const key = `${org.toLowerCase()}|${call}`;
    const t = now().getTime();
    const prev = lastLogged.get(key);
    if (prev !== undefined && t - prev <= LOG_INTERVAL_MS) return;
    lastLogged.set(key, t);
    logger.warn({ org, call, status }, "azure devops wait read failed");
  }

  async function rawGet(token: string, url: string): Promise<{ status: number; body: unknown }> {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 200) return { status: response.status, body: null };
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) return { status: response.status, body: null };
      return { status: 200, body: await response.json() };
    } catch {
      return { status: 0, body: null };
    }
  }

  async function getJson(
    companyId: string,
    org: string,
    call: string,
    url: string,
  ): Promise<unknown | null> {
    const token = await tokenProvider(companyId, org).catch(() => null);
    if (!token) return null;
    const result = await rawGet(token, url);
    if (result.body === null) {
      logFailure(org, call, result.status);
      return null;
    }
    return result.body;
  }

  async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const t = now().getTime();
    const hit = cache.get(key);
    if (hit && t - hit.at <= CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    if (value !== null) cache.set(key, { at: t, value });
    return value;
  }

  async function loadPr(companyId: string, ref: AzureDevOpsPullRequestReference): Promise<AdoPrSnapshot | null> {
    const org = ref.organization;
    const base = apiBase(org, ref.project);
    const prUrl = `${base}/git/repositories/${encodeURIComponent(ref.repository)}/pullrequests/${ref.number}`;
    const prBody = await getJson(companyId, org, "pr", `${prUrl}?api-version=7.1`);
    if (!isRec(prBody)) return null;
    const status = prBody.status;
    if (status !== "active" && status !== "completed" && status !== "abandoned") return null;
    const repository = isRec(prBody.repository) ? prBody.repository : {};
    const projectId = isRec(repository.project) ? str(repository.project.id) : null;
    const repositoryId = str(repository.id);

    const [iterBody, threadBody, evalBody, policyBody] = await Promise.all([
      getJson(companyId, org, "pr", `${prUrl}/iterations?api-version=7.1`),
      getJson(companyId, org, "pr", `${prUrl}/threads?api-version=7.1`),
      projectId
        ? getJson(
            companyId,
            org,
            "policies",
            `${base}/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${ref.number}`)}&api-version=7.1-preview`,
          )
        : Promise.resolve(null),
      repositoryId && str(prBody.targetRefName)
        ? getJson(
            companyId,
            org,
            "policies",
            `${base}/git/policy/configurations?repositoryId=${encodeURIComponent(repositoryId)}&refName=${encodeURIComponent(str(prBody.targetRefName)!)}&policyType=${ADO_BUILD_POLICY_TYPE_ID}&api-version=7.1`,
          )
        : Promise.resolve(null),
    ]);
    if (!isRec(iterBody) || !isRec(threadBody) || !isRec(evalBody)) return null;

    let lastPushAt: string | null = null;
    for (const item of arr(iterBody.value)) {
      const created = isRec(item) ? str(item.createdDate) : null;
      if (created && (!lastPushAt || Date.parse(created) > Date.parse(lastPushAt))) lastPushAt = created;
    }

    const threads: AdoThread[] = [];
    for (const item of arr(threadBody.value)) {
      if (!isRec(item) || typeof item.id !== "number" || item.isDeleted === true) continue;
      const comments: AdoComment[] = arr(item.comments).filter(isRec).filter((c) => c.isDeleted !== true).map((c) => ({
        authorUniqueName: isRec(c.author) ? (str(c.author.uniqueName) ?? "") : "",
        parentCommentId: typeof c.parentCommentId === "number" ? c.parentCommentId : 0,
        commentType: str(c.commentType) ?? "",
        publishedAt: str(c.publishedDate) ?? "",
        lastUpdatedAt: str(c.lastUpdatedDate) ?? str(c.publishedDate) ?? "",
      }));
      const props = isRec(item.properties) ? item.properties : {};
      const propValue = (name: string) => {
        const p = props[name];
        return isRec(p) ? p.$value : undefined;
      };
      let vote: AdoThread["vote"] = null;
      if (propValue("CodeReviewThreadType") === "VoteUpdate") {
        const value = Number(propValue("CodeReviewVoteResult"));
        const first = comments[0];
        if (Number.isFinite(value) && first) {
          vote = { uniqueName: first.authorUniqueName, value, at: first.publishedAt };
        }
      }
      threads.push({ id: item.id, comments, vote });
    }

    const evaluations: AdoPolicyEvaluation[] = [];
    for (const item of arr(evalBody.value)) {
      if (!isRec(item)) continue;
      const type = isRec(item.configuration) && isRec(item.configuration.type) ? item.configuration.type.id : null;
      if (typeof type !== "string" || type.toLowerCase() !== ADO_BUILD_POLICY_TYPE_ID) continue;
      // An optional build policy can stay queued forever; it never gates the merge.
      if (isRec(item.configuration) && item.configuration.isBlocking === false) continue;
      const context = isRec(item.context) ? item.context : {};
      const buildId = typeof context.buildId === "number" && context.buildId > 0 ? context.buildId : null;
      let buildSourceSha: string | null = null;
      let buildSourceVersion: string | null = null;
      if (buildId !== null) {
        const build = await getJson(companyId, org, "builds", `${base}/build/builds/${buildId}?api-version=7.1`);
        if (isRec(build)) {
          buildSourceVersion = str(build.sourceVersion);
          buildSourceSha = isRec(build.triggerInfo) ? str(build.triggerInfo["pr.sourceSha"]) : null;
        }
      }
      evaluations.push({
        status: str(item.status) ?? "unknown",
        isExpired: context.isExpired === true,
        buildId,
        buildSourceSha,
        buildSourceVersion,
      });
    }

    const hasBuildPolicy = isRec(policyBody)
      ? arr(policyBody.value).some((p) => isRec(p) && p.isEnabled === true && p.isBlocking === true)
      : null;

    return {
      status,
      lastMergeSourceCommit: isRec(prBody.lastMergeSourceCommit) ? str(prBody.lastMergeSourceCommit.commitId) : null,
      lastMergeCommit: isRec(prBody.lastMergeCommit) ? str(prBody.lastMergeCommit.commitId) : null,
      lastPushAt,
      evaluations,
      hasBuildPolicy,
      threads,
    };
  }

  async function loadBuild(
    companyId: string,
    target: Extract<AdoWaitTarget, { kind: "build" }>,
  ): Promise<AdoBuildSnapshot | null> {
    const base = apiBase(target.organization, target.project);
    const body = await getJson(
      companyId,
      target.organization,
      "builds",
      `${base}/build/builds/${target.buildId}?api-version=7.1`,
    );
    if (!isRec(body)) return null;
    const raw = body.status;
    const status: AdoBuildSnapshot["status"] | null =
      raw === "completed" ? "completed"
        : raw === "inProgress" || raw === "cancelling" ? "inProgress"
          : raw === "notStarted" || raw === "postponed" ? "notStarted"
            : null;
    if (!status) return null;
    const result = str(body.result);
    const finishTime = str(body.finishTime);
    if (status === "completed") return { status, result, waitingOnApproval: false, finishTime };
    const timeline = await getJson(
      companyId,
      target.organization,
      "builds",
      `${base}/build/builds/${target.buildId}/timeline?api-version=7.1`,
    );
    if (!isRec(timeline)) return null;
    const waitingOnApproval = arr(timeline.records).some(
      (r) => isRec(r) && r.state === "inProgress" && r.type === "Checkpoint.Approval",
    );
    return { status, result, waitingOnApproval, finishTime };
  }

  return {
    pr(companyId: string, ref: AzureDevOpsPullRequestReference): Promise<AdoPrSnapshot | null> {
      const key = `pr|${companyId}|${ref.organization}/${ref.project}/${ref.repository}#${ref.number}`.toLowerCase();
      return cached(key, () => loadPr(companyId, ref));
    },
    build(
      companyId: string,
      target: Extract<AdoWaitTarget, { kind: "build" }>,
    ): Promise<AdoBuildSnapshot | null> {
      const key = `build|${companyId}|${target.organization}/${target.project}#${target.buildId}`.toLowerCase();
      return cached(key, () => loadBuild(companyId, target));
    },
    async probe(
      companyId: string,
      organization: string,
      project: string,
    ): Promise<{ builds: number; policies: number }> {
      const token = await tokenProvider(companyId, organization).catch(() => null);
      if (!token) return { builds: 0, policies: 0 };
      const base = apiBase(organization, project);
      const [builds, policies] = await Promise.all([
        rawGet(token, `${base}/build/builds?$top=1&api-version=7.1`),
        rawGet(token, `${base}/policy/configurations?$top=1&api-version=7.1`),
      ]);
      return { builds: builds.status, policies: policies.status };
    },
  };
}
