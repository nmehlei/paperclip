# Azure DevOps

Paperclip recognizes Azure DevOps pull requests in merge confirmations, the same
way it recognizes GitHub pull requests.

## Merge confirmations

A pending `request_confirmation` that asks only for a merge and links Azure
DevOps pull requests is accepted by the system once every linked pull request is
completed. The periodic merge sweep checks them; there is no webhook path yet.
Acceptance follows the interaction's continuation policy, so
`wake_assignee_on_accept` wakes the assignee to verify the merge and continue.

Recognized links:

- `https://dev.azure.com/{organization}/{project}/_git/{repository}/pullrequest/{id}`
- `https://dev.azure.com/{organization}/_git/{repository}/pullrequest/{id}`, where
  the project has the repository's name
- `https://{organization}.visualstudio.com/{project}/_git/{repository}/pullrequest/{id}`

An abandoned pull request is never treated as merged; the confirmation stays
pending for a person to answer.

## Credential

The sweep reads a personal access token with **Code (Read)** scope from a company
secret, chosen per organization so that organizations in different Microsoft Entra
tenants can each have their own token:

1. `AZURE_DEVOPS_TOKEN_<ORG>`, `AZURE_DEVOPS_PAT_<ORG>` or `AZURE_DEVOPS_EXT_PAT_<ORG>`,
   where `<ORG>` is the organization name in upper case, with each run of characters
   other than letters and digits replaced by `_` (`my-org` becomes `AZURE_DEVOPS_PAT_MY_ORG`);
2. `AZURE_DEVOPS_TOKEN`, `AZURE_DEVOPS_PAT` or `AZURE_DEVOPS_EXT_PAT`, shared by all
   organizations;
3. the server's `AZURE_DEVOPS_EXT_PAT` environment variable.

Without a token, or with one the organization rejects, Azure DevOps pull requests
resolve as unknown and their confirmations stay pending.
