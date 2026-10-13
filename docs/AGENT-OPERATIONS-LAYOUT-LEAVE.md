# Agent, Operations and layout release

Portfolio tables retain bounded assignee names and readable dates/statuses. Narrow split panels stack; phones use the shared labeled task cards. Removed the obsolete four-column mobile rules that mislabeled the five-column table. Calendar agenda badges no longer inherit the full-width day-chip rule. Credit budgets use searchable labeled controls, an explicit submit form and separate spend/reserved/available metrics. Existing plan and tenant budget rules remain authoritative.

Ask Agent uses the shared gradient ring, glass core and spark from the latest uploaded UI, with a reduced-motion alternative. The futuristic button layer is retained; portfolio sizing and task cards use the verified responsive layout. Support Center navigation, pages, services, API controllers and worker are removed. Old links redirect to Operations. Operations retains its existing operational work, SLA and verified support resolution features. Applied migrations and storage mappings remain archival compatibility only; no historical support records are deleted or copied into a new tenant.

## Planned leave

New native tools `propose_planned_leave` and `list_planned_leave` resolve every person and check workspace/module/reporting-line permissions. Mutations require the existing durable confirmation card, and permission is rechecked at execution. A manual timesheet panel provides review/confirmation and per-day cancellation. Entries remain Planned: this does not grant HR approval, send leave email, mark paid leave, or add worked/billable hours. Missing or different dates must be clarified. No example customer tasks, reminders or leave were created during this development.

Migration `20261012171600_PlannedTimesheetLeave` adds only `PlannedLeaves` and indexes. The tenant/user/date unique index prevents active duplicates; request identity permits safe retries and prevents cancelled-request replay. Multi-person/range creation is atomic, bounded to 10 people/31 days, and rejects submitted/approved weeks. No new environment variables, services or AI provider changes. Optional provider gates stay unchanged.

## Verification

Scripted model tests cover two-person confirmations, no writes before approval, duplicate prevention, role revocation, cross-tenant rejection, overlap, cancellation replay and locked weeks. Production-bundle synthetic browser checks cover long task titles/assignees, split views, phone headings and correct column labels, calendar rows, credit form values, review-before-save leave and reduced motion. No bulk or paid provider testing. Local UI screenshots are generated before committing; CI stores screenshots as artifacts. Production backup is encrypted with Windows DPAPI and restore-tested locally; temporary SSH access is revoked and local keys removed.
