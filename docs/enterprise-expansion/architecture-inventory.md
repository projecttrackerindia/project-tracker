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
