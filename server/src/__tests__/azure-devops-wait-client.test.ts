import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ getByName: async () => null, resolveSecretValue: async () => "" }),
}));

import {
  ADO_BUILD_POLICY_TYPE_ID,
  createAdoWaitClient,
  parseAdoWaitTarget,
} from "../services/azure-devops-wait-client.js";

const ref = {
  host: "dev.azure.com",
  organization: "pharao2k",
  project: "NME-IaC",
  repository: "NME-IaC",
  number: 1556,
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const prBody = {
  status: "active",
  lastMergeSourceCommit: { commitId: "src1" },
  lastMergeCommit: { commitId: "merge1" },
  targetRefName: "refs/heads/main",
  repository: { id: "repo-1", project: { id: "proj-1" } },
};
const iterations = { value: [
  { id: 1, createdDate: "2026-11-13T16:43:00Z" },
  { id: 3, createdDate: "2026-11-14T09:00:00Z" },
  { id: 2, createdDate: "2026-11-13T18:00:00Z" },
] };
const threads = { value: [
  { id: 1, comments: [
    { author: { uniqueName: "a@x" }, parentCommentId: 0, commentType: "text", publishedDate: "2026-11-13T10:00:00Z", lastUpdatedDate: "2026-11-13T10:01:00Z" },
    { author: { uniqueName: "b@x" }, parentCommentId: 1, commentType: "text", publishedDate: "2026-11-13T11:00:00Z", lastUpdatedDate: "2026-11-13T11:00:00Z" },
  ] },
  { id: 2, comments: [
    { author: { uniqueName: "v@x" }, parentCommentId: 0, commentType: "system", publishedDate: "2026-11-14T20:50:18.237Z", lastUpdatedDate: "2026-11-14T20:50:18.237Z" },
  ], properties: {
    CodeReviewThreadType: { $type: "System.String", $value: "VoteUpdate" },
    CodeReviewVoteResult: { $type: "System.String", $value: "-5" },
  } },
] };
const evaluations = { value: [
  { status: "approved", configuration: { type: { id: ADO_BUILD_POLICY_TYPE_ID } }, context: { buildId: 77, isExpired: false } },
  { status: "queued", configuration: { type: { id: ADO_BUILD_POLICY_TYPE_ID } }, context: { buildId: 0, isExpired: true } },
  { status: "approved", configuration: { type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" } }, context: {} },
] };
const policyConfigs = (items: Array<{ isEnabled: boolean; isBlocking: boolean }>) => ({ value: items });

type Routes = Record<string, () => Response>;
function router(routes: Routes) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, make] of Object.entries(routes)) if (u.includes(needle)) return make();
    return json({}, 404);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const prRoutes = (over: Routes = {}): Routes => ({
  "/pullrequests/1556/iterations": () => json(iterations),
  "/pullrequests/1556/threads": () => json(threads),
  "/_apis/policy/evaluations": () => json(evaluations),
  "/_apis/build/builds/77": () => json({ sourceVersion: "merge1", triggerInfo: { "pr.sourceSha": "src1" } }),
  "/_apis/git/policy/configurations": () => json(policyConfigs([{ isEnabled: true, isBlocking: true }])),
  "/pullrequests/1556?": () => json(prBody),
  ...over,
});

function client(fetchImpl: typeof fetch, token: string | null = "pat", now: () => Date = () => new Date()) {
  return createAdoWaitClient({} as Db, { tokenProvider: async () => token, fetch: fetchImpl, now });
}

describe("parseAdoWaitTarget", () => {
  it("accepts PR and build URLs", () => {
    expect(parseAdoWaitTarget("https://dev.azure.com/pharao2k/NME-IaC/_git/NME-IaC/pullrequest/1556")).toEqual({ kind: "pr", ref });
    expect(parseAdoWaitTarget("https://dev.azure.com/pharao2k/NME-IaC/_build/results?buildId=4690&view=results")).toEqual({
      kind: "build", organization: "pharao2k", project: "NME-IaC", buildId: 4690,
    });
  });
  it("rejects other URLs", () => {
    expect(parseAdoWaitTarget("https://github.com/nmehlei/paperclip/pull/1")).toBeNull();
    expect(parseAdoWaitTarget("https://dev.azure.com/pharao2k/NME-IaC/_build/results")).toBeNull();
    expect(parseAdoWaitTarget("not a url")).toBeNull();
  });
});

describe("pr()", () => {
  it("maps evaluations, threads, votes and the newest push", async () => {
    const { fn } = router(prRoutes());
    const snap = await client(fn).pr("c1", ref);
    expect(snap).toEqual({
      status: "active",
      lastMergeSourceCommit: "src1",
      lastMergeCommit: "merge1",
      lastPushAt: "2026-11-14T09:00:00Z",
      hasBuildPolicy: true,
      evaluations: [
        { status: "approved", isExpired: false, buildId: 77, buildSourceSha: "src1", buildSourceVersion: "merge1" },
        { status: "queued", isExpired: true, buildId: null, buildSourceSha: null, buildSourceVersion: null },
      ],
      threads: [
        { id: 1, vote: null, comments: [
          { authorUniqueName: "a@x", parentCommentId: 0, commentType: "text", publishedAt: "2026-11-13T10:00:00Z", lastUpdatedAt: "2026-11-13T10:01:00Z" },
          { authorUniqueName: "b@x", parentCommentId: 1, commentType: "text", publishedAt: "2026-11-13T11:00:00Z", lastUpdatedAt: "2026-11-13T11:00:00Z" },
        ] },
        { id: 2, vote: { uniqueName: "v@x", value: -5, at: "2026-11-14T20:50:18.237Z" }, comments: [
          { authorUniqueName: "v@x", parentCommentId: 0, commentType: "system", publishedAt: "2026-11-14T20:50:18.237Z", lastUpdatedAt: "2026-11-14T20:50:18.237Z" },
        ] },
      ],
    });
  });

  it("ignores disabled and non-blocking build policies", async () => {
    const { fn } = router(prRoutes({
      "/_apis/git/policy/configurations": () => json(policyConfigs([
        { isEnabled: false, isBlocking: true },
        { isEnabled: true, isBlocking: false },
      ])),
    }));
    expect((await client(fn).pr("c1", ref))?.hasBuildPolicy).toBe(false);
  });

  it("queries the git-area policy configurations endpoint", async () => {
    const { fn, calls } = router(prRoutes());
    await client(fn).pr("c1", ref);
    const url = calls.find((u) => u.includes("policy/configurations"))!;
    expect(url).toContain("/_apis/git/policy/configurations?");
    expect(url).toContain("repositoryId=repo-1");
    expect(url).toContain("refName=refs%2Fheads%2Fmain");
  });

  it("reports hasBuildPolicy null when the policy call fails", async () => {
    const { fn } = router(prRoutes({ "/_apis/git/policy/configurations": () => json({}, 500) }));
    expect((await client(fn).pr("c1", ref))?.hasBuildPolicy).toBeNull();
  });

  it("is null without a token, on 401 and on html", async () => {
    const ok = router(prRoutes());
    expect(await client(ok.fn, null).pr("c1", ref)).toBeNull();
    expect(ok.calls).toHaveLength(0);
    expect(await client(router({ "/pullrequests/1556?": () => json({}, 401) }).fn).pr("c1", ref)).toBeNull();
    const html = router({ "/pullrequests/1556?": () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) });
    expect(await client(html.fn).pr("c1", ref)).toBeNull();
  });

  it("caches for 5 minutes", async () => {
    let t = Date.parse("2026-11-14T10:00:00Z");
    const { fn, calls } = router(prRoutes());
    const c = client(fn, "pat", () => new Date(t));
    await c.pr("c1", ref);
    const first = calls.length;
    t += 4 * 60_000;
    await c.pr("c1", ref);
    expect(calls.length).toBe(first);
    t += 60_000 + 1_000;
    await c.pr("c1", ref);
    expect(calls.length).toBe(first * 2);
  });
});

describe("build()", () => {
  const target = { kind: "build", organization: "pharao2k", project: "NME-IaC", buildId: 4690 } as const;
  it("is null on 203 and 401", async () => {
    expect(await client(router({ "/builds/4690": () => new Response("", { status: 203 }) }).fn).build("c1", target)).toBeNull();
    expect(await client(router({ "/builds/4690": () => json({}, 401) }).fn).build("c1", target)).toBeNull();
  });
  it("detects an approval checkpoint", async () => {
    const { fn } = router({
      "/builds/4690/timeline": () => json({ records: [
        { type: "Stage", state: "inProgress" },
        { type: "Checkpoint.Approval", state: "inProgress" },
      ] }),
      "/builds/4690": () => json({ status: "inProgress" }),
    });
    expect(await client(fn).build("c1", target)).toEqual({ status: "inProgress", result: null, waitingOnApproval: true });
  });
  it("does not treat a plain checkpoint as waiting on approval", async () => {
    const { fn } = router({
      "/builds/4690/timeline": () => json({ records: [{ type: "Checkpoint", state: "inProgress" }] }),
      "/builds/4690": () => json({ status: "inProgress" }),
    });
    expect((await client(fn).build("c1", target))?.waitingOnApproval).toBe(false);
  });
  it("maps a finished build", async () => {
    const { fn } = router({ "/builds/4690": () => json({ status: "completed", result: "succeeded" }) });
    expect(await client(fn).build("c1", target)).toEqual({ status: "completed", result: "succeeded", waitingOnApproval: false });
  });
});

describe("probe()", () => {
  it("returns statuses only", async () => {
    const { fn, calls } = router({
      "/_apis/build/builds": () => json({}, 200),
      "/_apis/policy/configurations": () => json({}, 401),
    });
    expect(await client(fn).probe("c1", "pharao2k", "NME-IaC")).toEqual({ builds: 200, policies: 401 });
    expect(calls.every((u) => u.includes("$top=1"))).toBe(true);
  });
  it("maps network failures to 0", async () => {
    const fn = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await client(fn).probe("c1", "pharao2k", "NME-IaC")).toEqual({ builds: 0, policies: 0 });
  });
});

describe("read failure logging", () => {
  it("logs a read failure once per org and call per hour", async () => {
    loggerWarn.mockClear();
    let t = Date.parse("2026-11-14T10:00:00Z");
    const { fn } = router({ "/_apis/": () => json({}, 401) });
    const c = client(fn, "pat", () => new Date(t));
    const b = (org: string) => ({ kind: "build", organization: org, project: "P", buildId: 1 }) as const;
    await c.build("c1", b("pharao2k"));
    await c.build("c1", b("pharao2k"));
    t += 30 * 60_000;
    await c.build("c1", b("pharao2k"));
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith({ org: "pharao2k", call: "builds", status: 401 }, "azure devops wait read failed");
    t += 30 * 60_000 + 1_000;
    await c.build("c1", b("pharao2k"));
    expect(loggerWarn).toHaveBeenCalledTimes(2);
    await c.build("c1", b("Donable"));
    expect(loggerWarn).toHaveBeenCalledTimes(3);
    await c.pr("c1", { ...ref, number: 1556 });
    // pr read of pharao2k fails on its first call (call name "pr"), separate from "builds"
    expect(loggerWarn).toHaveBeenCalledTimes(4);
  });

  it("logs a policies failure separately from builds in the same hour", async () => {
    loggerWarn.mockClear();
    const t = Date.parse("2026-11-14T10:00:00Z");
    const { fn } = router(prRoutes({ "/_apis/git/policy/configurations": () => json({}, 401) }));
    const c = client(fn, "pat", () => new Date(t));
    await c.build("c1", { kind: "build", organization: "pharao2k", project: "P", buildId: 1 });
    await c.pr("c1", ref);
    expect(loggerWarn).toHaveBeenCalledWith({ org: "pharao2k", call: "builds", status: 404 }, "azure devops wait read failed");
    expect(loggerWarn).toHaveBeenCalledWith({ org: "pharao2k", call: "policies", status: 401 }, "azure devops wait read failed");
  });
});
