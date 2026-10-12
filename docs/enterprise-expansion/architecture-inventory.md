# Enterprise expansion: verified inventory

Inspected 11 October 2026 from main b695a434, before application edits.

React/TypeScript routes: frontend/src/App.tsx. SettingsPage.tsx implements My account and Google Workspace; api/client.ts supplies authenticated downloads and uploads. There is no resume or certification module.

ASP.NET Core uses Domain/Application/Infrastructure/Api projects. IAppDbContext, CurrentContext, PermissionService and ProjectAccess enforce service boundaries. AppDbContext.QueryFilters.cs narrows tenant/project/document reads. Personal resumes need an owner filter: organization administrators must not inherit private resume access. PostgreSQL production runs EF migrations at startup. SQLite development/testing creates fresh databases with EnsureCreated; explicitly reviewed additive expansion operations now upgrade existing SQLite tables at startup.

EntitlementService resolves effective subscriptions, expired-plan fallback, overrides and seat scaling. Catalog codes FREE/PRO/BUSINESS/ENTERPRISE are verified. FeatureKeys and PlanFeatures are the central entitlement mechanism. AiCreditService reserves/settles pooled monthly credits and user/team budgets. AiRequestLimitService controls admission; IAiClient abstracts primary/fallback providers. Workspace AI-disabled settings must apply to new assistance.

AiFileService bounds and validates uploads and uses OpenXML for DOCX extraction; PDF is model input rather than a general text parser. IFileStorage supports filesystem/S3. The custom project PDF renderer substitutes unsupported Unicode. Resume exports therefore need maintained portable PDF rendering and licensed embedded fonts; OpenXML is already available through ClosedXML.

WorkTaskService, WorkTasks, types, comments, attachments, assignments and history provide operational support. SlaService has first-response/resolution clocks, pause and risk/breach reporting. SupportResolutionService provides version-bound reporter acknowledgement. Existing AutomationService runs project rules/scheduled triggers, not a full branching durable workflow studio. AiOperations has durable jobs and lease recovery.

GoogleCalendarAuthService/GoogleMeetingClient provide user-owned Calendar/Meet. Slack uses tenant-owned OAuth with encrypted tokens, validated state/signatures and deduplicated lifecycle events; interactive actions remain disabled. At the initial audit, no verified WhatsApp or Microsoft productivity integration existed; gated adapter checkpoints are recorded below. External activation needs credentials, scopes, consent, verified identities and current provider requirements.

RazorpayPaymentProvider implements subscriptions, not one-time Orders. Resume purchases need immutable owner/version/template/format binding, Orders-specific signature validation, captured-payment lookup, reconciliation and refund handling. Browser assertions never grant clean exports.

Tests use mocked providers and SQLite/PostgreSQL CI. No live AI bulk tests or actual customer messages/calendar changes are authorized for verification.

## Risks and gaps

Resumes contain personal information. Original user-entered facts and selected organization evidence stay separate; assigned work alone is not accomplishment evidence. Only completed and verified outcomes qualify. Authorization must be rechecked before using stored evidence. Paid artifacts must be immutable and retry-safe. Tax treatment and external provider activation remain configuration decisions. Secrets must remain server-side.

Private email extension reuses the existing Google OAuth/token protection, IAiClient provider routing, shared AI credit ledger, Recorder audit chain and workspace-scoped React queries. Draft metadata is queried separately from content; a committed send-state claim precedes bounded network I/O. No new hosted service or inbox permission is introduced.

Microsoft personal productivity now reuses ProviderOAuthAttempts, ISecretProtector, WorkspaceExecutionPrincipal, private email drafts and the shared AI credit pipeline. A fixed-host delegated OAuth/send adapter and workspace-scoped settings section add no separate worker or hosted service. Gmail and Microsoft share durable confirmation receipts and send caps. Inbox/thread reading, calendar mutation receipts and WhatsApp remain separate release work.

Private calendar proposals reuse the existing Google token store, NodaTime IANA database, current execution principal and workspace-scoped settings queries. A dedicated personal flow persists its claim before a provider write and supports read-only outcome reconciliation. Existing project-meeting creation/reschedule/attendee/cancel paths are preserved and still need their own durable-operation upgrade; this personal flow does not silently change them.

## WhatsApp inbound foundation checkpoint
Added a separate organization-owned installation schema and raw-body-signed webhook receiver. At this historical receiver-only checkpoint there was no installation endpoint or provider HTTP client. The verified installation checkpoint below supersedes that limitation; sending and AI invocation remain unavailable. Fixture installations are used only in isolated tests; no live Meta workspace has been connected.

The central WHATSAPP_INTEGRATION boolean entitlement defaults to absent/zero and uses the existing subscription/override system. No plan is assumed eligible. Exact app/business-account/phone-ID mapping is resolved globally only after signature validation, followed by tenant-scoped writes and active-subscription checks.

## Verified installation checkpoint
WhatsApp now uses the existing ProviderOAuthAttempts, tenant ledger lock, secret protector and entitlement service for Embedded Signup. React loads Meta's SDK on demand without a new npm dependency; the second user click opens signup. ASP.NET exchanges the code and verifies the business account and selected verified phone against Meta before storing a protected tenant token. This replaces the earlier receiver-only installation limitation. No messaging or AI processing is enabled.

## Private WhatsApp contact proof checkpoint
The signed receiver now recognizes only bounded PT-LINK challenges initiated by an authenticated organization member. WhatsAppContactService shares the existing central entitlement system and tenant ledger lock with installation handling. Private user-owned link rows store protected phone values and app-secret-keyed, tenant-specific fingerprints. Account notifications contains the self-service controls; no new provider client, background sender or AI call is introduced. Responsive remounts retain a short-lived code only in the existing user/workspace-scoped memory cache, which authentication and workspace changes clear.

## Notification consent checkpoint and voice boundary
WhatsAppContactService now stores separate notification-purpose consent and three closed categories on the existing private tenant/user contact row. The service reuses NodaTime, central entitlements and the tenant ledger lock; settings remain workspace-scoped. Grants and revocations use a version fence. Installation/contact resets also revoke notification consent. No sender worker, new external dependency or AI call is introduced.

Current hosted workers still run inside ProjectManagement.Api. The user selected voice agents as a follow-on release; a separate voice worker/gateway entrypoint is proposed before live calling. See [repository audit and decision](voice-agent-follow-on.md), including public Outpero evidence limits and the boundaries for shared identity, permissions and billing.

## Read-only provider health checkpoint
WhatsAppHealthService reuses the existing tenant ledger, central entitlement service, protected installation token, audit recorder and fixed-host named HTTP client. Claims commit before provider I/O; a fresh tracked connection is retrieved after reads so disconnect/reconnect changes cannot be overwritten by a stale tracked snapshot. The Meta installation adapter additionally implements read-only token, asset and subscription inspection. No sender, background worker, new dependency or automatic provider action is introduced.

## Template contract checkpoint
WhatsAppTemplateService owns three versioned English-US plain-body notification contracts. MetaWhatsAppInstallationProvider implements IWhatsAppTemplateProvider using three exact-name GET reads on the organization's verified WABA; settings GET itself performs none. The settings component remains in the existing lazy-loaded settings chunk. Template approval cannot activate reception or sending. A durable sender/outbox and authorized external support actions are still absent and remain phase-1 implementation work.

## Durable WhatsApp delivery worker
The existing API hosted-worker pattern now polls bounded organization IDs with relevant queued work or recent opted-in notifications. Payload reads occur within the selected tenant. Up to four organizations run in parallel; per-tenant ledger locks protect claims and budgets across replicas. Preparation leases recover after restart; a committed outbound attempt becomes unknown if its acknowledgement is lost and is not resubmitted.

Read-only token/asset/subscription/template readiness is cached for at most five minutes under configuration and connection fencing, avoiding seven repeated provider reads for each recipient. Every outbound attempt still checks current member access, plan, resource assignment/status, phone proof, consent/version, quiet hours and budgets. Provider revocation after a cached observation can reject delivery; readiness is not a guarantee. Support public replies/status changes create generic recipient notifications; private notes do not.

## Idle WhatsApp metadata maintenance checkpoint

Added background WhatsAppMetadataMaintenance to the existing maintenance cycle and reused its tenant-scoped recovery/retention path during delivery polling. It runs independently of provider activation and active subscription: cleaning operational metadata does not grant integration access. Global scheduling returns only tenant IDs based on timestamps/states. Separate scopes and tenant-ledger transactions fence each batch; no message contents, recipient phone, token or business-resource data are read, and no provider or AI calls occur.

A pass selects at most ten installations, including inactive mappings, ordered by a persisted RetentionPolledAt marker so a backlog rotates between organizations. Each operation changes/deletes at most 100 rows. Expired preparation with no persisted attempt returns to the queue; expired queued notifications are suppressed. Lost send leases become unknown and remain non-replayable. Live leases and inconsistent/unrecognized states are retained. Normal recipient/permission/consent/provider gates still control any later delivery.

Deletion requires a recognized terminal state and every tracked creation/change/attempt/acceptance/provider-status timestamp to be older than thirty days. Recent callbacks or acknowledgements survive even when the row was created earlier. Recovery decisions update their timestamp and get a fresh retention window. Incoming receipt metadata uses its received timestamp. Installation ownership, token material, reserved phone mappings and user consent are preserved.

Migration 20261011161936_WhatsAppMetadataRetention adds nullable WhatsAppConnection.RetentionPolledAt and four indexes for retention ordering, tenant/created-time scans, expired queue work and expired leases. The SQLite additive migration allowlist now contains eighteen reviewed migrations. Repeat-upgrade checks preserve existing mappings/tokens and leave the polling marker null; EF reports no pending model changes.

Local verification: 177 focused tests pass, covering all WhatsApp regressions plus maintenance, prior SQLite upgrades, bypass review and personal-file cleanup. The eleven new maintenance cases cover disabled/inactive installs, recent-evidence windows, abandoned reads/sends, live/unknown states, bounded repeated cleanup, private tenant separation, concurrent independent scopes and eleven-organization rotation. Concurrent scopes exercise database fencing but do not prove every cross-process replica/restart scenario. Real PostgreSQL upgrade and execution for the new migration must be confirmed from the next CI run.

All six CI jobs passed on prior revision 98095cb in run 38154219373, including the Linux browser previews and actual-main PostgreSQL upgrade. That evidence is a baseline, not the result of the new retention code. The technical batch-reference image was shown before committing; no new product UI is added in this backend batch. No AI bulk tests, real customer/provider sends, main merge, production variables or Railway deployment were performed. Six grouped release workstreams remain open; physically orphaned mappings/files, other integration retention, wider restart/replica coverage and the remaining provider/payment/productivity gates still require work.


Consolidated studio/upload checkpoint: shared StudioHero and accessible template cards preserve lazy feature chunks; the workflow view is URL-backed. PersonalFileUpload persists storage-cleanup intent before upload, then consumes it with pointer publication. PersonalFileCleanup now performs globally reviewed key-existence checks under a receipt transaction. The full expanded scope remains the required merge boundary.


## Private inbox boundary
PersonalInboxService and PersonalInboxController add own-mailbox metadata/conversation reads using existing per-person encrypted OAuth connections. Optional read scopes are recorded on durable OAuth attempts. Provider results remain request-local, plain text, bounded and authorization-rechecked; UI content remains component-local rather than a shared query cache. Attachments, source-grounded summaries and calendar expansion remain separate open capabilities.


## Private summary execution
PersonalInboxSummaryService reuses PersonalInboxService, the shared AI router/client, AiCreditService, entitlement resolution, secret protection and audit infrastructure. AiRequestLimit admission is enforced on the POST controller, while GET receipt retrieval performs no inference. No new queue, vector database or provider service is introduced. Consent epochs separate stable review identity from rotating OAuth access/refresh credentials. Private frontend text remains local component state and is retired on account/thread/workspace changes; source navigation uses literal rendered message content. Housekeeping reuses MaintenanceService, and credit recovery reuses the existing operations processor's expired-reservation scan.
