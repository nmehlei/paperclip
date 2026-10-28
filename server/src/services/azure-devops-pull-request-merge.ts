import type { Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import type { PullRequestMergeState } from "./github-pull-request-merge.js";

export type AzureDevOpsPullRequestReference = {
  host: "dev.azure.com";
  organization: string;
  project: string;
  repository: string;
  number: number;
};

export const DEFAULT_AZURE_DEVOPS_TOKEN_SECRET_NAMES = [
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_PAT",
  "AZURE_DEVOPS_EXT_PAT",
] as const;

export const AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN =
  /https:\/\/(?:dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)|([A-Za-z0-9][A-Za-z0-9-]*)\.visualstudio\.com)\/(?:([^\s/?#]+)\/)?_git\/([^\s/?#]+)\/pullrequest\/([1-9][0-9]*)/gi;

const AZURE_DEVOPS_REQUEST_TIMEOUT_MS = 10_000;

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractAzureDevOpsPullRequestReferences(values: readonly unknown[]) {
  const references = new Map<string, AzureDevOpsPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN)) {
      const number = Number(match[5]);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      const organization = match[1] ?? match[2]!;
      const repository = decodeSegment(match[4]!);
      const project = match[3] ? decodeSegment(match[3]) : repository;
      const key = `${organization}/${project}/${repository}#${number}`.toLowerCase();
      if (!references.has(key)) {
        references.set(key, { host: "dev.azure.com", organization, project, repository, number });
      }
    }
  }
  return [...references.values()];
}

// One identity rarely reaches every organization (organizations in different Microsoft Entra
// tenants cannot share a PAT), so each organization may carry its own secret,
// e.g. AZURE_DEVOPS_PAT_CONTOSO; the plain names are the shared fallback.
export type AzureDevOpsTokenProvider = (companyId: string, organization: string) => Promise<string | null>;

export function azureDevOpsOrganizationSecretName(baseName: string, organization: string) {
  return `${baseName}_${organization.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function createAzureDevOpsTokenProvider(
  db: Db,
  opts: { secretNames?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): AzureDevOpsTokenProvider {
  const secrets = secretService(db);
  return async (companyId, organization) => {
    const baseNames = opts.secretNames ?? DEFAULT_AZURE_DEVOPS_TOKEN_SECRET_NAMES;
    const secretNames = [
      ...baseNames.map((name) => azureDevOpsOrganizationSecretName(name, organization)),
      ...baseNames,
    ];
    for (const secretName of secretNames) {
      const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
      if (!secret) continue;
      const token = await secrets
        .resolveSecretValue(companyId, secret.id, "latest")
        .then((value) => value.trim())
        .catch(() => "");
      if (token) return token;
    }
    const env = opts.env ?? process.env;
    return env.AZURE_DEVOPS_EXT_PAT?.trim() || null;
  };
}

export function azureDevOpsPullRequestApiUrl(reference: AzureDevOpsPullRequestReference) {
  const segments = [reference.organization, reference.project]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://dev.azure.com/${segments}/_apis/git/repositories/${encodeURIComponent(reference.repository)}/pullrequests/${reference.number}?api-version=7.1`;
}

export function azureDevOpsPullRequestMergeState(body: unknown): PullRequestMergeState {
  const status = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).status
    : undefined;
  if (status === "completed") return "merged";
  if (status === "active" || status === "abandoned") return "open";
  return "unknown";
}

export function createAzureDevOpsPullRequestMergeStateResolver(
  db: Db,
  opts: { tokenProvider?: AzureDevOpsTokenProvider; fetch?: typeof fetch } = {},
) {
  const tokenProvider = opts.tokenProvider ?? createAzureDevOpsTokenProvider(db);
  const fetchImpl = opts.fetch ?? fetch;
  return async (
    companyId: string,
    reference: AzureDevOpsPullRequestReference,
  ): Promise<PullRequestMergeState> => {
    const token = await tokenProvider(companyId, reference.organization).catch(() => null);
    if (!token) return "unknown";
    try {
      const response = await fetchImpl(azureDevOpsPullRequestApiUrl(reference), {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(AZURE_DEVOPS_REQUEST_TIMEOUT_MS),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status !== 200 || !contentType.includes("application/json")) return "unknown";
      return azureDevOpsPullRequestMergeState(await response.json());
    } catch {
      return "unknown";
    }
  };
}
