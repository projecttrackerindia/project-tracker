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

At the Embedded Signup checkpoint, contact proof was next; it is now implemented below. Outbound consent, token/scope health, provider subscription readiness, templates, the 24-hour policy and durable outbox/recovery remain. Existing inbox/calendar, payment reconciliation, support, parser/export and database release gates remain open. This is another tested checkpoint, not a complete coordinated release or production deployment.

## Contact proof continuation
Implemented private member-initiated phone verification, explicit account-link consent, signed exact-sender proof, protected phone storage, replay/expiry/connection-epoch fencing, owner-only settings and removal. Messaging and integration activation remain off. Notification consent, current messaging policy, provider/token health and durable outbound delivery are still implementation gates.

## Remaining release phases as of this checkpoint
These are six grouped workstreams, not six fixed-size commits. Existing foundations reduce work within each phase; no completion percentage or delivery date is claimed.

| Phase | Remaining work | Current state |
| --- | --- | --- |
| 1. WhatsApp delivery | External customer identity and support boundaries; controlled provider-contract, phone-registration and webhook-delivery validation; authorized interactive support/task actions | Installation, contact proof, consent, provider health/templates and durable internal-member outbox/status reconciliation implemented; live activation off |
| 2. Personal productivity | Inbox/thread retrieval and summaries; attachments; Microsoft calendars; attendee/multi-calendar availability; AI proposals; durable existing project-meeting mutations | OAuth, confirmed email sends and private Google blocks implemented behind gates |
| 3. Support and agent workflows | Business-hour/skill/availability routing, custom fields, deeper SLA policies, workflow recovery and replica contention; source-grounded recommendations and accuracy checks | Metrics, reviewed routing and two-stage approved escalation implemented |
| 4. Resume commercial readiness | Visual Word watermark/export quality, Linux parser isolation, verified organization evidence, captured-payment/tax reconciliation for INR49 plus applicable taxes | Private studio, plan caps, imports and branded exports implemented; checkout off |
| 5. Production hardening | Account purge/orphan cleanup, idle integration retention, disposable PostgreSQL upgrades from main, permission/privacy and concurrency checks | SQLite additive upgrades and focused isolation tests pass; PostgreSQL release validation pending |
| 6. Release verification | Remaining regression/browser/accessibility checks, final reviewed PR and authorized merge, exact-commit Railway deployment/health verification | Not ready for coordinated merge/deployment |

Continue phase 1 next with current messaging/delivery policy, approved templates and durable outbox/reconciliation. Controlled provider-contract, phone-registration and webhook-delivery verification remain rollout gates. Separate private notification consent is implemented in the checkpoint below. Phases may overlap locally, but commercial checkout and external activation cannot precede their verification gates. No AI bulk testing or real customer messages/calendar writes are included in the plan.

## Notification consent continuation
Implemented explicit current-user notification-purpose acceptance, selected categories and IANA quiet hours; purpose lifetime is bound to current phone proof. Versioned saves, independent revocation and phone/installation reset invalidation are covered by focused mocked tests. Delivery remains off. This advances phase 1 but completes none of the six remaining workstreams.

## Voice release preference
The user selected voice agents as a follow-on release after these six workstreams. [Voice architecture and evidence audit](voice-agent-follow-on.md) recommends one shared product with a separately deployed voice runtime and five follow-on stages. No voice worker, live calls or employee studio is included in this current checkpoint.

## Provider health continuation
Implemented default-off administrator read checks for current token/app/lifetime, scoped WABA grants, exact business/phone and subscribed app. Durable claims/cooldown, sanitized unknown outcomes, stale-result hiding and post-network permission/epoch/configuration fencing are covered by mocked regression tests. Check success cannot activate messaging or claim phone registration/webhook delivery readiness. This advances phase 1; all six release workstreams remain open. Voice remains the separate five-stage follow-on release.

## Template contract continuation
Implemented default-off administrator template reads, fixed privacy-preserving notification bodies, exact Meta approval/category/locale/content checks, durable claims/cooldown, stale/late-result fencing and customer setup instructions. Notifications are designed to require approved utility templates regardless of the customer-service window; free-form replies remain unavailable. This is the contract/check foundation, not an implemented delivery worker or complete WhatsApp phase. All six workstreams remain open.

## Conditional effort estimate - 11 October 2026
Allow roughly 20-30 focused engineering days (4-6 working weeks) for the remaining coordinated release. This is a planning allowance from the current scope, not a measured completion prediction or calendar commitment. Voice is excluded and follows later. Suggested allocation: WhatsApp delivery/authorized actions 5-7 days; productivity 4-6; support/workflows 3-5; resume/payments 3-5; production hardening/release 4-7. These ranges overlap and the overall range is rounded; do not sum the upper bounds as a promised schedule. Re-estimate after durable delivery and the first disposable PostgreSQL upgrade expose their actual constraints. Provider account/app approval, controlled delivery verification, payment/tax configuration and production access are external prerequisites without a known completion date; they may extend elapsed time. Work proceeds during active sessions; this estimate does not imply unattended work between turns.

## Durable internal-member delivery checkpoint
Implemented the default-off durable outbox/worker, generic approved-template transport, signed status reconciliation, current recipient/resource authorization, quiet hours, rolling notification budgets and private/admin delivery history. Public support updates feed the existing notification path; private notes cannot generate external messages. Restarts recover read preparation, while lost outbound acknowledgements stay unknown until a verified callback resolves them.

This advances phase 1 without completing all six workstreams. External customer identity and authorized interactive support/task actions, controlled provider/phone/webhook/template verification and the other five workstreams remain. Next priority is disposable PostgreSQL upgrade/concurrency validation and remaining commercial/productivity requirements. Voice stays a follow-on release. No AI bulk tests or live customer delivery were performed.
