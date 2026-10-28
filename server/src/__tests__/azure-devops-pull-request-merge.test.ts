import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  azureDevOpsOrganizationSecretName,
  azureDevOpsPullRequestApiUrl,
  createAzureDevOpsPullRequestMergeStateResolver,
  createAzureDevOpsTokenProvider,
  extractAzureDevOpsPullRequestReferences,
} from "../services/azure-devops-pull-request-merge.js";

const companySecrets = vi.hoisted(() => new Map<string, string>());

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: async (_companyId: string, name: string) =>
      companySecrets.has(name) ? { id: name } : null,
    resolveSecretValue: async (_companyId: string, id: string) => companySecrets.get(id) ?? "",
  }),
}));

const reference = {
  host: "dev.azure.com",
  organization: "contoso",
  project: "Web Platform",
  repository: "web-app",
  number: 1296,
} as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function resolverWith(fetchImpl: typeof fetch, token: string | null = "pat-value") {
  return createAzureDevOpsPullRequestMergeStateResolver({} as Db, {
    tokenProvider: async () => token,
    fetch: fetchImpl,
  });
}

describe("Azure DevOps pull-request references", () => {
  it("extracts dev.azure.com and visualstudio.com URLs, decoding and deduplicating them", () => {
    expect(extractAzureDevOpsPullRequestReferences([
      "Merge https://dev.azure.com/contoso/Web%20Platform/_git/web-app/pullrequest/1296.",
      "Same PR: https://dev.azure.com/Contoso/web%20platform/_git/Web-App/pullrequest/1296",
      "Legacy: https://contoso.visualstudio.com/Infra/_git/infra/pullrequest/7",
      "Short: https://dev.azure.com/contoso/_git/tools/pullrequest/12",
    ])).toEqual([
      { host: "dev.azure.com", organization: "contoso", project: "Web Platform", repository: "web-app", number: 1296 },
      { host: "dev.azure.com", organization: "contoso", project: "Infra", repository: "infra", number: 7 },
      { host: "dev.azure.com", organization: "contoso", project: "tools", repository: "tools", number: 12 },
    ]);
  });

  it("ignores non pull-request Azure DevOps links", () => {
    expect(extractAzureDevOpsPullRequestReferences([
      "https://dev.azure.com/contoso/Web/_git/web-app?path=/README.md",
      "https://dev.azure.com/contoso/Web/_build/results?buildId=5",
      "https://dev.azure.com/contoso/Web/_git/web-app/pullrequest/0",
    ])).toEqual([]);
  });

  it("builds the repository-scoped REST URL with encoded segments", () => {
    expect(azureDevOpsPullRequestApiUrl(reference)).toBe(
      "https://dev.azure.com/contoso/Web%20Platform/_apis/git/repositories/web-app/pullrequests/1296?api-version=7.1",
    );
  });
});

describe("Azure DevOps pull-request merge state", () => {
  it("maps completed to merged and sends the token as basic auth", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "completed" }));
    await expect(resolverWith(fetchImpl as unknown as typeof fetch)("company-1", reference)).resolves.toBe("merged");
    expect(fetchImpl).toHaveBeenCalledWith(
      azureDevOpsPullRequestApiUrl(reference),
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(":pat-value").toString("base64")}`,
        }),
      }),
    );
  });

  it("maps active and abandoned to open", async () => {
    for (const status of ["active", "abandoned"]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ status }));
      await expect(resolverWith(fetchImpl as unknown as typeof fetch)("company-1", reference)).resolves.toBe("open");
    }
  });

  it("returns unknown without calling Azure DevOps when no token is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "completed" }));
    await expect(resolverWith(fetchImpl as unknown as typeof fetch, null)("company-1", reference)).resolves.toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns unknown for sign-in pages, redirects, errors and network failures", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => new Response("<html>Sign in</html>", { status: 203, headers: { "content-type": "text/html" } }),
      async () => new Response(null, { status: 302, headers: { location: "https://login.example" } }),
      async () => jsonResponse({ message: "not found" }, 404),
      async () => {
        throw new Error("network down");
      },
    ];
    for (const respond of responses) {
      const fetchImpl = vi.fn(respond);
      await expect(resolverWith(fetchImpl as unknown as typeof fetch)("company-1", reference)).resolves.toBe("unknown");
    }
  });
});

describe("Azure DevOps tokens per organization", () => {
  it("derives the organization secret name from the organization", () => {
    expect(azureDevOpsOrganizationSecretName("AZURE_DEVOPS_PAT", "contoso")).toBe("AZURE_DEVOPS_PAT_CONTOSO");
    expect(azureDevOpsOrganizationSecretName("AZURE_DEVOPS_PAT", "my-org.eu")).toBe("AZURE_DEVOPS_PAT_MY_ORG_EU");
  });

  it("prefers the organization secret over the shared one", async () => {
    companySecrets.clear();
    companySecrets.set("AZURE_DEVOPS_PAT", "shared");
    companySecrets.set("AZURE_DEVOPS_PAT_FABRIKAM", "fabrikam-only");
    const provider = createAzureDevOpsTokenProvider({} as Db, { env: {} });
    await expect(provider("company-1", "Fabrikam")).resolves.toBe("fabrikam-only");
    await expect(provider("company-1", "contoso")).resolves.toBe("shared");
  });

  it("returns null when neither an organization nor a shared token exists", async () => {
    companySecrets.clear();
    companySecrets.set("AZURE_DEVOPS_PAT_FABRIKAM", "fabrikam-only");
    const provider = createAzureDevOpsTokenProvider({} as Db, { env: {} });
    await expect(provider("company-1", "contoso")).resolves.toBeNull();
  });

  it("asks the token provider for the pull request's organization", async () => {
    const tokenProvider = vi.fn(async () => "pat-value");
    const resolver = createAzureDevOpsPullRequestMergeStateResolver({} as Db, {
      tokenProvider,
      fetch: (async () => jsonResponse({ status: "completed" })) as unknown as typeof fetch,
    });
    await resolver("company-1", reference);
    expect(tokenProvider).toHaveBeenCalledWith("company-1", "contoso");
  });
});
