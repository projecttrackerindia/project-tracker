# Enterprise expansion data model — implementation checkpoint

Personal data uses explicit owner query filters in addition to service guards. Organization records implement ITenantScoped; a support record's business access also follows its underlying WorkTask and project permissions.

| Entity | Ownership and purpose | Important invariants |
| --- | --- | --- |
| PersonalResume | Account owner; library metadata | Version concurrency token; at most 20 resumes |
| ResumeVersion | Account owner; immutable text and provenance | Unique resume/number; at most 100 versions; approval applies to one version |
| EmployeeCertification | Account owner; self-reported credential | Private by default; profile projection includes only explicitly shared badge fields; at most 100 records and 10 private 2 MB attachments |
| ResumeExportPurchase | Account owner; immutable paid fulfillment | Unique owner/version/template/format and gateway references; INR4,900 paise base plus saved tax; captured payment and artifact hash required |
| PersonalFileDeletion | Internal storage cleanup receipt; no user-facing API | Pointer removal and receipt commit together; idempotent deletion, retry/backoff; receipt survives owner/source deletion |
| SupportTicket | Organization; metadata for existing operational work | Unique tenant/work ID; WorkTask supplies assignment, project, attachments, resolution and SLA |
| SupportInteraction | Organization; requester replies or private staff notes | Unique ticket/author/request key; 8,000 character body; at most 2,000 interactions |
| SupportTicketLink | Organization; related or merged tickets | Unique source/target; caller must manage both for mutations; linked IDs are rechecked before disclosure |
| SupportWorkflow | Organization; draft and publication pointer | Current entitlements and workflow/Operations permissions; version concurrency; at most 30 definitions |
| SupportWorkflowRevision | Organization; immutable published graph | Unique definition/revision; at most 100 revisions; rollback creates another publication |
| SupportWorkflowEvent | Organization; durable trigger metadata | Unique tenant/request key; captures eligible revision IDs at event time; capacity pressure retains the event |
| SupportWorkflowRun | Organization; persistent node execution | Unique tenant/workflow/request key; manual keys include requester; executor membership rebuilt at every step; atomic lease and receipt |
| SupportWorkflowStep | Organization; completed-node receipt | Unique run/node; approval identity retained; effects and receipt commit together |
| SupportWorkflowSchedule | Organization; recurring review of one authorized ticket | Unique workflow/ticket; 5 minutes to 7 days; coalesces missed periods and avoids overlapping active runs |

Additive migrations currently scaffolded:

1. 20261011021558_PersonalResumesAndCertifications
2. 20261011023413_ResumeExportsAndSupportTickets
3. 20261011024744_CertificationExpiryReminders
4. 20261011025027_PrivateCertificationAttachments
5. 20261011030531_DurableSupportWorkflows
6. 20261011035406_DurablePersonalFileCleanup

SQLite API integration tests have applied these migrations successfully. PostgreSQL upgrade validation remains a release gate. Additional external identity, channel outbox, productivity connection and delivery reconciliation models are still required; their design must reuse existing encrypted integration storage and authorization conventions.
## Durable provider OAuth attempts
Migration 20261011051417_DurableProviderOAuthAttempts adds ProviderOAuthAttempts with provider, owner/tenant identifiers, state/browser hashes, safe local return path, expiry and atomic consumption timestamp. State and browser proof are never stored in clear text. The table is intentionally available to anonymous callbacks only through the paired hashes; the current owner principal is rebuilt before any connection access. A user foreign key cascades account deletion. Existing GoogleConnection rows are unchanged.

## Private email drafts
Migration 20261011053210_PersonalEmailDrafts adds tenant-scoped, user-owned message content and immutable send-state receipts. Version is a concurrency token. Status moves draft -> sending -> accepted/unknown; neither sending nor unknown permits another dispatch. Accepted receipt removal erases recipient/subject/body while preserving confirmation time and provider receipt, including rate-limit history. Account deletion cascades these rows; full account/workspace purge verification remains a release check.