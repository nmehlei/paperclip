import type { Db } from "@paperclipai/db";
import {
  createPullRequestMergeStateResolver,
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
  type PullRequestMergeState,
} from "./github-pull-request-merge.js";
import {
  createAzureDevOpsPullRequestMergeStateResolver,
  extractAzureDevOpsPullRequestReferences,
  type AzureDevOpsPullRequestReference,
} from "./azure-devops-pull-request-merge.js";

export type MergeConfirmationPullRequestReference =
  | GitHubPullRequestReference
  | AzureDevOpsPullRequestReference;

export function extractMergeConfirmationPullRequestReferences(
  values: readonly unknown[],
): MergeConfirmationPullRequestReference[] {
  return [
    ...extractGitHubPullRequestReferences(values),
    ...extractAzureDevOpsPullRequestReferences(values),
  ];
}

export function pullRequestReferenceKey(reference: MergeConfirmationPullRequestReference) {
  if (reference.host === "dev.azure.com") {
    return `dev.azure.com/${reference.organization}/${reference.project}/${reference.repository}#${reference.number}`.toLowerCase();
  }
  return `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

export function pullRequestReferenceLabel(reference: MergeConfirmationPullRequestReference) {
  if (reference.host === "dev.azure.com") {
    return `${reference.organization}/${reference.project}/${reference.repository}!${reference.number}`;
  }
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

export function createMergeConfirmationPullRequestStateResolver(db: Db) {
  const resolveGitHub = createPullRequestMergeStateResolver(db);
  const resolveAzureDevOps = createAzureDevOpsPullRequestMergeStateResolver(db);
  return (
    companyId: string,
    reference: MergeConfirmationPullRequestReference,
  ): Promise<PullRequestMergeState> =>
    reference.host === "dev.azure.com"
      ? resolveAzureDevOps(companyId, reference)
      : resolveGitHub(companyId, reference);
}
