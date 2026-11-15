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

## Wait monitors

An agent that waits on an Azure DevOps pull request or build parks the issue with a
monitor and goes idle. The wait sweep, which runs with the other periodic sweeps,
checks the link and wakes the assignee when something it can act on happens, instead
of the agent polling. There is no webhook path.

Park the wait with a monitor of `kind: external_service` and
`serviceName: nme_ado_wait`. Recognized links:

- a pull request, in any of the forms listed under merge confirmations
- a build: `https://dev.azure.com/{organization}/{project}/_build/results?buildId={id}`

The fork redacts a monitor's `externalRef` on API writes, so the sweep reads the wait
link from `externalRef` if it is a raw Azure DevOps link, else from the last Azure
DevOps PR or build URL in the monitor notes (lines starting `Event:` are ignored).
Agents must therefore keep the link in the notes.

Events that wake the assignee:

- a watched pull request is completed or abandoned;
- a watched pull request has final validation (every build policy evaluation is
  approved, rejected, broken, not applicable or expired, and for the head commit) and,
  in an organization in `NME_ADO_REVIEWER_ORGS`, the AI review is in (a top-level
  comment by the configured identity after the last push, or 30 minutes after it);
- a watched build has finished;
- for a pending merge confirmation, new review comments or a rejecting vote on its
  pull request, once they are 10 minutes old, unless a monitor already watches that
  pull request;
- a merge confirmation was accepted by the merge sweep (`merge_accepted`).

A pipeline that waits on a manual approval extends the monitor to the 72 h backstop
instead of waking.

Each kept wake posts a system comment `Event: <summary>` on the issue (monitor notes
are not shown to agents).

### Bounds

- At most 6 sweep wakes per issue in 24 hours. A comment by a human user resets the
  count. The merge confirmation sweep shares the same per-issue count and lock, so the
  two sweeps together cannot exceed it.
- After a quota failure of the assignee's last run the issue is held until the quota
  resets (5 hours when the reset time cannot be read). A held merge card stays
  pending and is accepted on a later tick.
- At the cap, one `nme_ado_wait.paused` entry is logged (the pending event is recorded);
  further ticks add none until the next wake.

### Credential

The PAT needs **Code (Read)** and **Build (Read)** scopes, resolved per organization as
described under Credential below. Policy evaluations are read with API version
`7.1-preview`, everything else with `7.1`.

### Configuration

- `NME_ADO_REVIEWER_ORGS`: comma-separated organizations where an AI review is
  awaited before a pull request counts as ready (default `pharao2k`).
- `NME_ADO_AGENT_IDENTITIES`: JSON object mapping an organization to the unique name
  of the AI reviewer / agent identity there, e.g. `{"pharao2k":"jarvis@example.com"}`;
  its top-level comments mark the AI review as in, and its replies are not counted
  as external activity.
- `NME_ADO_PROBE_PROJECTS`: JSON object mapping an organization to a project, e.g.
  `{"pharao2k":"NME-IaC"}`; at startup the server checks that the stored PAT can read
  builds and policies there and logs the HTTP statuses only.
- `NME_ADO_WAIT_SWEEP=off`: kill switch. The wait sweep does nothing and the merge
  confirmation sweep behaves exactly as before (no lock, no wake history, no entries).

### Rollback

Set `NME_ADO_WAIT_SWEEP=off`, or pin the previous image (`2026.1023.0-nme.5`). Parked
waits then fall back to the 72 h backstop.

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
