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

SQLite API integration tests create the current schema with EnsureCreated; earlier fresh-database checks did not run the PostgreSQL migration chain. PostgreSQL upgrade validation remains a release gate. Additional external identity, channel outbox, productivity connection and delivery reconciliation models are still required; their design must reuse existing encrypted integration storage and authorization conventions.
## Durable provider OAuth attempts
Migration 20261011051417_DurableProviderOAuthAttempts adds ProviderOAuthAttempts with provider, owner/tenant identifiers, state/browser hashes, safe local return path, expiry and atomic consumption timestamp. State and browser proof are never stored in clear text. The table is intentionally available to anonymous callbacks only through the paired hashes; the current owner principal is rebuilt before any connection access. A user foreign key cascades account deletion. Existing GoogleConnection rows are unchanged.

## Private email drafts
Migration 20261011053210_PersonalEmailDrafts adds tenant-scoped, user-owned message content and immutable send-state receipts. Version is a concurrency token. Status moves draft -> sending -> accepted/unknown; neither sending nor unknown permits another dispatch. Accepted receipt removal erases recipient/subject/body while preserving confirmation time and provider receipt, including rate-limit history. Account deletion cascades these rows; full account/workspace purge verification remains a release check.
## Microsoft connections and provider-aware receipts
Migration 20261011062100_MicrosoftProductivityAndEmailProviders adds MicrosoftConnections with a unique tenant/user pair, cascading user ownership, provider identity, sender email, granted scopes, protected access/refresh tokens and expiry. ProviderOAuthAttempts gains nullable protected PKCE verifier storage. PersonalEmailDrafts gains provider (default google for existing records), nullable provider request ID and nullable sender captured at confirmation. Old receipt sender identities are not fabricated. Removing accepted content also erases the captured sender while retaining confirmation/rate history.

## SQLite expansion startup upgrades
SQLite development databases do not run the historic PostgreSQL migration chain. SqliteEnterpriseUpgrade now applies an explicit list of reviewed additive expansion migrations in a transaction, skipping existing tables, columns and indexes. It refuses raw SQL, destructive operations, table rebuilds and unreviewed migration types. Startup is repeatable and keeps existing private content. This does not upgrade arbitrary historic core-schema differences or replace PostgreSQL migration validation.

## Private calendar proposals
Migration 20261011065223_PersonalCalendarProposals adds owner/tenant-scoped PersonalCalendarProposals, exact UTC times, IANA zone, immutable saved content, concurrency version, reviewed account, confirmation/verification timestamps and stable provider event ID. Lifecycle: draft -> sending -> verified/unknown; recovery can move unknown/stale sending to verified through provider read-back only. Local erasure clears text, account and proposed times while keeping confirmation history. User deletion cascades ownership.
The explicit SQLite expansion allowlist now includes this tenth additive migration.

## WhatsApp installation and inbound metadata
Migration 20261011073057_WhatsAppInboundFoundation creates WhatsAppConnections and WhatsAppInboundReceipts. Both are ITenantScoped. One installation per tenant and unique (AppId, PhoneNumberId) enforce organization mapping. Installation tokens use a protected-value field populated only by the verified signup flow described below; there is no manual registration endpoint.

Receipts contain provider message ID, message type, provider timestamp and receipt timestamp; they contain no sender number, text, attachment or inferred Project Tracker user. Unique (AppId, PhoneNumberId, ProviderMessageId) prevents replay across replicas. All public timestamps carry an explicit UTC offset. Disconnect empties the usable token and marks the connection inactive; its mapping remains reserved to prevent silent reassignment. Existing receipts remain metadata only.

The diagnostic list contains at most 50 entries from the last 30 days. Admission caps retained receipt rows at 10,000 per tenant; excess messages are acknowledged without adding metadata. At most 100 expired rows are physically purged per active, eligible webhook group. Idle-tenant/background erasure remains a release item; this is not a guarantee of physical deletion exactly on day 30.

The additive SQLite startup allowlist includes this migration. Existing-table upgrade is tested twice, preserving historical email receipts. PostgreSQL deployment and full upgrade/contention verification remain release gates.

## WhatsApp installation expiry
The twelfth reviewed additive expansion migration, 20261011091248_WhatsAppInstallationExpiry, adds nullable TokenExpiresAt to WhatsAppConnections. Historical tokens retain null (unknown lifetime); no expiry or permanent validity is invented. Explicit positive provider lifetimes are bounded and saved with a safety margin. Known expired connections are reported disconnected and cannot receive messages. Signup attempts reuse ProviderOAuthAttempts with provider=whatsapp, hashed state/browser proof and a protected configuration fingerprint. Disconnect removes even consumed attempts, fencing a late completion. Tests upgrade the actual previous WhatsApp schema twice while preserving its tenant mapping and protected token.

## Private WhatsApp contacts
Migration 20261011093926_WhatsAppPrivateContactLinks adds WhatsAppContactLinks (ITenantScoped). Unique tenant/user permits one current link per member; unique tenant/nullable PhoneHash prevents two verified users sharing a number within one organization. PhoneProtected holds the encrypted digits; PhoneHash is an app-secret HMAC bound to the tenant, not an enumerable plain phone hash. Pending rows have only a random challenge hash, issue/expiry times, connection ID/connection epoch and configuration fingerprint. Raw codes and general message text are not stored.

ConsentVersion/ConsentAt record account-link consent only. Outbound messaging requires separate consent. Verification expires after thirty days; status reads erase expired/stale phone and consent fields. Removal and business disconnect erase usable linkage but retain the hourly counter, preventing reset abuse. Expired or configuration-stale phone fingerprints are also erased when a new owner supplies valid proof, preventing stale uniqueness reservations. Proof claims are flushed within the tenant transaction before checking another proof in the same envelope. The thirteenth reviewed additive migration is included in SQLite startup; representative prior-schema upgrades remain repeatable. Idle cleanup and account-purge coverage remain release gates.

## WhatsApp notification-purpose consent
Migration 20261011102347_WhatsAppNotificationConsent adds NotificationPreferencesVersion, NotificationConsentVersion/At/ExpiresAt, three category booleans, NotificationTimeZone and NotificationQuietStartMinutes/EndMinutes to private WhatsAppContactLinks. Existing verified contacts retain their phone proof and admission counters; nullable consent and false category defaults never opt them into messaging. Quiet-hour migration defaults are 22:00 and 08:00, with UTC used until a zone is selected.

Notification consent is independent of account-link consent. Its expiry is bounded by VerifiedAt + 30 days. Changing preferences does not renew verification. Tracked and bulk contact invalidation clear consent/categories and advance versions to fence stale saves. The additive SQLite startup allowlist now includes fourteen expansion migrations; PostgreSQL full-chain upgrade verification remains pending.

## WhatsApp provider health metadata
Migration 20261011104645_WhatsAppProviderHealth adds nullable attempt/check times, lease ID/expiry, configuration fingerprint, bounded HealthState and five nullable observation booleans to WhatsAppConnections. Prior installations start unchecked with null observations; no readiness, credentials or new consent is invented. The real additive SQLite upgrader now includes fifteen reviewed migrations. Raw introspection payloads, scope/user lists, tokens and provider error messages are never stored as health data.

## Template observations
20261011111118_WhatsAppNotificationTemplates adds nine columns to WhatsAppConnections: attempt/check timestamps, lease ID/deadline, configuration/contract hash, aggregate state and three individual template states. Previous installations default to unchecked; no approvals are invented. Tenant filtering and existing unique mapping remain intact. No raw template payload or personal/project data is stored. Disconnect/reconnect clears observations/claims and preserves the attempt cooldown. SQLite's reviewed additive allowlist now contains sixteen migrations; full PostgreSQL upgrades remain a release gate.

## Durable WhatsApp outbox
Migration 20261011114854_DurableWhatsAppNotificationDelivery adds WhatsAppDeliveries and WhatsAppConnection.DeliveryPolledAt. Rows bind tenant/user, original notification and resource reference, installation epoch, contact/consent version, configuration fingerprint, lease, attempt/acceptance/status timestamps, provider message ID, random callback tag and recipient HMAC. Message content, plaintext phone and credentials are not stored in delivery rows.

Unique tenant/notification and tenant/callback indices prevent duplicate preparation. Connection/provider-message identity is unique when present. Terminal metadata has bounded thirty-day retention during polling. New columns/table are additive; existing installations and notifications are not granted consent or readiness. The reviewed SQLite expansion allowlist now contains seventeen migrations; full PostgreSQL upgrades remain a release gate.
