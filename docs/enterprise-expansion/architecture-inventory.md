# Enterprise expansion: verified inventory

Inspected 11 October 2026 from main b695a434, before application edits.

React/TypeScript routes: frontend/src/App.tsx. SettingsPage.tsx implements My account and Google Workspace; api/client.ts supplies authenticated downloads and uploads. There is no resume or certification module.

ASP.NET Core uses Domain/Application/Infrastructure/Api projects. IAppDbContext, CurrentContext, PermissionService and ProjectAccess enforce service boundaries. AppDbContext.QueryFilters.cs narrows tenant/project/document reads. Personal resumes need an owner filter: organization administrators must not inherit private resume access. PostgreSQL production runs EF migrations at startup. SQLite development/testing creates fresh databases with EnsureCreated; explicitly reviewed additive expansion operations now upgrade existing SQLite tables at startup.

EntitlementService resolves effective subscriptions, expired-plan fallback, overrides and seat scaling. Catalog codes FREE/PRO/BUSINESS/ENTERPRISE are verified. FeatureKeys and PlanFeatures are the central entitlement mechanism. AiCreditService reserves/settles pooled monthly credits and user/team budgets. AiRequestLimitService controls admission; IAiClient abstracts primary/fallback providers. Workspace AI-disabled settings must apply to new assistance.

AiFileService bounds and validates uploads and uses OpenXML for DOCX extraction; PDF is model input rather than a general text parser. IFileStorage supports filesystem/S3. The custom project PDF renderer substitutes unsupported Unicode. Resume exports therefore need maintained portable PDF rendering and licensed embedded fonts; OpenXML is already available through ClosedXML.

WorkTaskService, WorkTasks, types, comments, attachments, assignments and history provide operational support. SlaService has first-response/resolution clocks, pause and risk/breach reporting. SupportResolutionService provides version-bound reporter acknowledgement. Existing AutomationService runs project rules/scheduled triggers, not a full branching durable workflow studio. AiOperations has durable jobs and lease recovery.

GoogleCalendarAuthService/GoogleMeetingClient provide user-owned Calendar/Meet. Slack uses tenant-owned OAuth with encrypted tokens, validated state/signatures and deduplicated lifecycle events; interactive actions remain disabled. No verified WhatsApp or Microsoft productivity integration exists. External activation needs credentials, scopes, consent, verified identities and current provider requirements.

RazorpayPaymentProvider implements subscriptions, not one-time Orders. Resume purchases need immutable owner/version/template/format binding, Orders-specific signature validation, captured-payment lookup, reconciliation and refund handling. Browser assertions never grant clean exports.

Tests use mocked providers and SQLite/PostgreSQL CI. No live AI bulk tests or actual customer messages/calendar changes are authorized for verification.

## Risks and gaps

Resumes contain personal information. Original user-entered facts and selected organization evidence stay separate; assigned work alone is not accomplishment evidence. Only completed and verified outcomes qualify. Authorization must be rechecked before using stored evidence. Paid artifacts must be immutable and retry-safe. Tax treatment and external provider activation remain configuration decisions. Secrets must remain server-side.

Private email extension reuses the existing Google OAuth/token protection, IAiClient provider routing, shared AI credit ledger, Recorder audit chain and workspace-scoped React queries. Draft metadata is queried separately from content; a committed send-state claim precedes bounded network I/O. No new hosted service or inbox permission is introduced.

Microsoft personal productivity now reuses ProviderOAuthAttempts, ISecretProtector, WorkspaceExecutionPrincipal, private email drafts and the shared AI credit pipeline. A fixed-host delegated OAuth/send adapter and workspace-scoped settings section add no separate worker or hosted service. Gmail and Microsoft share durable confirmation receipts and send caps. Inbox/thread reading, calendar mutation receipts and WhatsApp remain separate release work.
