# Coordinated implementation plan

Initial architecture inspection is recorded before code changes. Work proceeds on feat/enterprise-resume-support, preserving existing functionality.

1. Add private resume/version/certification schema with owner guards and configurable central template caps: proposed defaults FREE 2, PRO 5, BUSINESS 8, ENTERPRISE 10, absolute maximum ten. Manual editing and branded export do not consume AI credits. Saved versions are immutable; approval binds one version.
2. Bound PDF/DOCX imports and parser complexity, preserve personal provenance, selected completed verified work and deletion controls. AI drafts use shared admission/provider/credit services, require review and never automatically become verified facts.
3. Implement portable PDF/editable DOCX, ten professional styles and pale Project Tracker watermark. Clean exports cost INR49 plus applicable taxes, bound to version/template/format; same-file retries are free. Gate checkout until pricing/tax and captured-payment reconciliation are verified.
4. Certifications: issuer, dates, credential, safe verification URL, privacy, archive, selected profile badges and expiry reminders. User uploads do not imply verification.
5. Extend operational work into support tickets with customer/internal messages, verified external identity, queues/routing, links/reopen/merge, reports, multilevel escalation and human handoff. Reuse existing work/SLA/resolution permission rules.
6. Versioned validated visual workflow studio, durable bounded execution, authorization revalidation, approval/wait/retry/failure/history and rollback. No arbitrary executable code.
7. Tenant-owned official WhatsApp and provider-neutral Google/Microsoft productivity adapters. External setup gates activation. Require consent and verified identities; confirm sends and calendar changes and verify provider outcomes.
8. Maintain data-model/API/security/integration/test/release docs. Use mocked regression tests, builds and SQLite/PostgreSQL migration checks. No bulk AI tests, real customer messages or calendar writes. Merge/deploy only after applicable release gates pass.

One coordinated release is requested. Interim commits are review checkpoints, not claims that unfinished modules are complete. The attachment's acceptance criteria remain release gates; blockers and disabled adapters must be reported accurately.

## Support continuation after checkpoint f1889ab
Implemented permission-aware SQL dashboard counts and complete bounded conversation paging, with stale-version protection and private-note filtering before pagination. Initial ticket detail now carries at most 50 messages. Remaining support release gates still include routing policies, multilevel escalation configuration, external verified identities and provider adapters; metrics do not claim predictive accuracy or live availability.

## Reviewed routing and staged escalation
Added deterministic authorized routing previews, explicit assignment confirmation and recorded team-lead/manager contacts. Added an editable two-stage SLA escalation preset using the durable workflow engine, separate approvals, bounded waits and completed-ticket stop conditions. Full configurable expertise/availability routing, custom field conditions and external provider adapters remain release work; current suggestions intentionally rely only on existing records.

## Provider connection foundation
Before expanding mailbox access, hardened the existing Google callback against browser substitution, replay and stale membership. Fixed reconnection under the correct tenant, added actual Calendar-scope capability reporting and a reconnect action. New provider adapters and mailbox/document workflows still remain implementation work; these callback protections are a prerequisite, not evidence that the adapters are finished.

## Private email continuation
Implemented private manual drafts, bounded metadata-first retrieval, shared-credit AI rewriting and separately confirmed Gmail dispatch with durable duplicate protection. Added optional send-only OAuth consent; deployment sending remains off by default. Inbox/thread retrieval, attachments, durable calendar operation receipts, WhatsApp adapters, provider recovery and the other coordinated release gates remain work. This checkpoint is not the complete expansion release.
## Microsoft sending continuation
Implemented disabled-by-default delegated OAuth with PKCE, protected rotating tokens, owner/workspace isolation, settings/setup controls and explicitly confirmed Outlook sends through the existing private editor. Provider selection survives AI rewriting. Graph acceptance and unknown outcomes have durable receipts; reconnects preserve the historical sender. Remaining productivity work includes inbox/thread summaries, attachments, durable calendar proposals/actions and provider recovery. This is a tested checkpoint within the coordinated release, not a completed expansion.

## Durable personal calendar continuation
Implemented saved private time-block proposals, explicit account/time/content review, fresh conflict checks, persistent claims, read-back verification and read-only reconciliation. The Google deployment gate stays off. This covers personal Google blocks only; AI scheduling, attendees, multi-calendar availability, project-meeting mutation receipts and Microsoft calendars remain implementation/release work. Existing project meeting behavior is preserved.

## WhatsApp inbound continuation
Implemented disabled reception, tenant-owned installation/receipt models, centralized plan access, raw-body signature verification, replay protection, bounded metadata-only storage, local disconnect and organization settings/preparation instructions. Tests use fixture installations in two isolated organizations; no live provider calls or AI tests run. This is the receiver foundation, not a completed WhatsApp adapter.

The receiver-only checkpoint was followed by Embedded Signup, recorded below; verified contact linking and consent are still next. Only after those pass should templates, the 24-hour policy, outbox delivery/recovery and permission-aware support actions be added. No customer installation/sending action should be enabled in this checkpoint. The coordinated release still requires the previously recorded productivity, payment, support, parser/export and database gates.

## Embedded Signup continuation
Implemented the browser-bound, one-use customer installation flow, server-side code exchange and provider asset verification, protected tokens, known-expiry handling, configuration-change fencing and disconnect race protection. Added two-step settings controls and production CSP support. Both installation and reception remain default-off; sending remains unavailable.

Next WhatsApp work is verified contact linking and consent, token/scope health and provider subscription readiness, followed by templates, the 24-hour policy and durable outbox/recovery. Existing inbox/calendar, payment reconciliation, support, parser/export and database release gates remain open. This is another tested checkpoint, not a complete coordinated release or production deployment.
