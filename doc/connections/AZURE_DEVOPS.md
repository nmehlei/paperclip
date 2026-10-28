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

The sweep reads a personal access token with **Code (Read)** scope from the first
company secret named `AZURE_DEVOPS_TOKEN`, `AZURE_DEVOPS_PAT` or
`AZURE_DEVOPS_EXT_PAT`, and falls back to the server's `AZURE_DEVOPS_EXT_PAT`
environment variable. Without a token, Azure DevOps pull requests resolve as
unknown and their confirmations stay pending.
