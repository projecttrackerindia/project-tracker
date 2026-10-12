# Enterprise expansion release runbook — not yet release-ready

The requested release is coordinated across resume/certifications, support/workflows and safe external integration boundaries. Do not merge or deploy this branch as a completed enterprise expansion while modules or applicable acceptance gates remain unfinished.

1. Finish implementation and update the inventory, model, contracts and security review to match the actual code. Keep WhatsApp/Microsoft disabled as requested; configured-provider activation is separate from testable adapter implementation.
2. Verify isolated parser execution in the Linux deployment, current-source/privacy checks, document rendering verification, workflow recovery and external identity/delivery/confirmation boundaries. Verify tax/accounting/reconciliation before turning on cash checkout.
3. Review all additive migrations against disposable SQLite and PostgreSQL databases. Test upgrading a database at current main, not only creating a fresh database. Back up production before migration.
4. Run focused security/payment/workflow regression checks, the full existing backend suite, frontend tests/build and browser accessibility/layout checks. Run no bulk AI tests or real customer message/calendar operations.
5. Review explicit changed files only. Preserve historical untracked logs/TestResults and the other checkout; restore only generated frontend tsbuildinfo changes before staging.
6. Create a reviewable PR with the final scope, migration names, environment variables, real validation results and disabled features. Require all applicable CI checks before the authorized merge to main.
7. Verify Railway API and frontend deployments for the exact merged commit. Check migrations/startup/health, served frontend assets and controlled-account read-only navigation. Do not infer deployment success from a merge or local build.
8. Keep Resume__Checkout__Enabled false until production payment/tax/accounting gates pass. Keep external integrations disabled until their approved accounts and setup are verified. Inspect worker failures and durable queues after rollout.

Rollback: disable newly published workflows and cash checkout first if needed. Application rollback must remain compatible with additive schema. Do not remove production columns/tables or paid accounting records during an emergency rollback. Old workflow revisions stop before their next action when a new revision is published or the workflow is disabled; completed business actions remain audited.
Google OAuth foundation additionally requires migration 20261011051417_DurableProviderOAuthAttempts. Deploy schema before API; preserve existing encrypted Google connections and GoogleCalendar variables. Old in-flight cached OAuth attempts must restart. Smoke-test browser cookie retention and reconnection using a controlled account before enabling expanded provider capabilities. This phase does not make the coordinated release ready to merge.

## Personal email checkpoint
Apply additive migration 20261011053210_PersonalEmailDrafts before the API upgrade. Keep GoogleCalendar__MailEnabled false until Gmail API/OAuth audience verification and controlled-account readiness checks pass. Manual drafts and entitled AI editing do not require enabling mail. Do not retry sending/unknown rows from a background job or manually reset their status. Investigate the user's Gmail Sent folder and retain the durable receipt. Automated provider reconciliation, retention/account purge verification and inbox/calendar/WhatsApp functions are still release work. No production provider settings were changed during this checkpoint.
## Microsoft sending checkpoint
Apply 20261011062100_MicrosoftProductivityAndEmailProviders after the private email migration. Existing Gmail rows receive provider=google; historic sender stays null. Keep MicrosoftProductivity__Enabled=false until registration, delegated consent, token protection and controlled-account checks are verified. No production variables were changed in this checkpoint. Never reset sending/unknown states to force a retry. Account purge, PostgreSQL upgrade/contention, provider recovery and the coordinated release gates remain outstanding.

## SQLite expansion startup upgrades
SQLite development databases do not run the historic PostgreSQL migration chain. SqliteEnterpriseUpgrade now applies an explicit list of the nine additive expansion migrations in a transaction, skipping existing tables, columns and indexes. It refuses raw SQL, destructive operations, table rebuilds and unreviewed migration types. Startup is repeatable and keeps existing private content. This does not upgrade arbitrary historic core-schema differences or replace PostgreSQL migration validation.

## Private calendar checkpoint
Deploy schema 20261011065223_PersonalCalendarProposals before the API. Keep GoogleCalendar__PersonalCalendarEnabled=false until controlled-account readiness checks pass. SQLite development startup adds the tenth reviewed expansion migration idempotently. Check original-account reconnect and read-only reconciliation; never reset sending/unknown records to force a second provider write. Local receipt removal is separate from provider-event deletion. No production configuration was changed in this checkpoint.

## WhatsApp receiver checkpoint deployment gates
Apply 20261011073057_WhatsAppInboundFoundation before upgrading the API; additive SQLite startup support is included. WHATSAPP_INTEGRATION remains zero unless explicitly configured through the existing plan or tenant override system. Leave WhatsApp__WebhookReceptionEnabled=false; current production accounts are not configured.

Do not insert installation rows manually in production or reuse one organization's token across customers. Automated tests insert synthetic rows solely to verify routing. Customer signup is now implemented behind its default-off gate, as described below; there is no live sending or business-action path.

Before activation: complete official signup and verification; preserve token-protection keys across replicas; verify exact app/WABA/phone ownership; check proxy logging and TLS; verify contact authorization/consent and current Meta messaging rules; add durable sending/recovery and idle-data erasure; apply the full PostgreSQL upgrade in a disposable database and test replica contention. Disconnect removes local token access only; customers revoke remote grants separately.

## Embedded Signup checkpoint deployment gates
Apply 20261011091248_WhatsAppInstallationExpiry after the foundation migration before deploying the API. SQLite startup includes twelve reviewed additive expansion migrations. Preserve token-protection keys across replicas. Leave both WhatsApp__InstallationEnabled and WhatsApp__WebhookReceptionEnabled false until controlled-account readiness checks pass; never create production installation rows manually.

Review configured Meta app, business verification/review, Embedded Signup config, allowed HTTPS domains, exact API/signup version and delegated scopes. Test the real SDK against deployed CSP and verify provider code exchange and token lifetime/introspection with a controlled account. No provider subscription/phone registration is automated here. Audit proxy/collector logging, validate account ownership, then finish contact proof/consent, messaging policy and durable outbox/recovery before any outbound activation.

Run disposable PostgreSQL upgrades from main and replica contention checks before the coordinated merge. The full requested release still has productivity, accounting/payment, support, retention, parser and export gates. This checkpoint does not authorize declaring the whole release ready or deployed.

## Contact proof checkpoint deployment gates
Apply 20261011093926_WhatsAppPrivateContactLinks after installation expiry before the API upgrade. SQLite startup now contains thirteen reviewed additive expansion migrations. Keep WhatsApp__ContactLinkingEnabled=false and webhook reception off until controlled-account provider setup is approved and verified. Deploying the code does not enable sending.

Verify the configured business number with the organization administrator, actual signed sender/code payload and exact phone formatting using a controlled account. Check same-user/organization controls and token-protection continuity across replicas. Contact proof grants no notification consent or business permissions. Complete separate outbound consent, provider health, policy, outbox and recovery before activation; then finish the six remaining workstreams documented in implementation-plan.md before the coordinated merge. No production variables or customer records were changed in this phase.

## Notification consent checkpoint
Apply 20261011102347_WhatsAppNotificationConsent after private contact links. Its Up operations only add columns; existing contacts get no messaging consent. Disposable prior-contact SQLite upgrades run twice and preserve phone ownership, proof and rate history. The SQLite allowlist contains fourteen reviewed expansion migrations. Production PostgreSQL upgrades/contention must still be verified before release.

Keep installation/contact/reception default-off as previously specified. There is no outbound activation switch or sender. Confirm owner-only grant/revoke, stale-version conflicts, midnight-crossing quiet hours and installation/phone expiry invalidation using fake providers first. Complete provider health/readiness, current messaging policy, recipient permissions and durable outbox/status recovery before any real delivery. No production variables or customer data were changed here.

Voice agents follow the current six workstreams per the user's release preference. The [voice design](voice-agent-follow-on.md) is a proposal, not a deployed service or reason to delay the current release for live calling.

## Provider health checkpoint gates
Apply 20261011104645_WhatsAppProviderHealth after notification consent. Up operations only add columns; previous installations remain unchecked. Representative historical SQLite installation upgrades run twice and preserve tenant/token ownership without inventing health. Full PostgreSQL migration/contention verification remains required for the coordinated release.

Keep WhatsApp__HealthChecksEnabled=false until approved controlled-account configuration and strict provider response/granular-scope validation pass. Preserve protected-token keys and confirm application HTTP logging/telemetry excludes secret-bearing Graph URLs; configured OpenTelemetry already filters graph.facebook.com traces and the named client removes request loggers. Do not use a shared customer token. Read health is independent of installation/reception flags and cannot enable sending.

Verify token expiry/data-access expiry, app identity, WABA grants, exact assets, subscribed app, stale-result hiding, disconnect and lease recovery. Then validate actual phone registration and webhook delivery separately. No production changes or provider mutation were performed at this checkpoint. Finish policy/templates, durable outbound delivery/reconciliation, authorized support actions and the other five workstreams before the coordinated merge/deployment.

## Template contract checkpoint gates
Apply 20261011111118_WhatsAppNotificationTemplates after provider health. Its Up only adds columns and existing mappings stay unchecked. The real additive SQLite upgrader ran twice against the prior installation schema and preserved protected tokens/tenant ownership; this is not full PostgreSQL release validation. Keep WhatsApp__TemplateChecksEnabled=false. Preserve token-protection keys and the existing secret-bearing Graph logging/tracing exclusions.

Controlled verification must confirm exact template-name filtering, locale, approval/category/component shape and app-secret-proof support for the configured Graph version. Template read success alone cannot establish phone registration, actual delivery, member permission/consent, quiet-hour enforcement, spending limits or sender recovery. Durable outbox/status reconciliation and authorized support actions remain next. No production variables or provider records were changed, and this expansion remains unmerged/undeployed.

## Durable notification checkpoint gates
Apply 20261011114854_DurableWhatsAppNotificationDelivery after notification templates. The prior-installation SQLite upgrade is tested twice, retains tenant/token ownership and leaves the outbox empty; EF reports no pending model changes. A full PostgreSQL upgrade from main and replica-contention check is still required before the coordinated release.

Keep WhatsApp__DeliveryEnabled=false and existing provider gates off. Preserve token-protection keys across replicas, review notification budgets, and validate real versioned send/receipt/opaque-callback contracts with controlled accounts before activation. Static approved generic templates carry no project/task/ticket contents. Readiness caches expire after five minutes; current recipient authorization and consent are rechecked before every persisted attempt. Unknown outcomes require verified receipts and must not be manually queued as retries.

No real provider messages, AI bulk tests, production variables/records, main merge or Railway deployment were performed. Six workstreams remain open; this commit is a tested checkpoint within the requested coordinated release.

## Export and disposable upgrade verification
The branded Word watermark now defines its referenced shape and each template has schema coverage. Visual Microsoft Word/export rendering remains a release check; the installed WPS automation is not evidence that this passed. Purchases remain disabled until captured-payment/tax configuration is verified.

CI explicitly runs PostgresExpansionUpgradeTests against a random disposable database, migrating to main baseline 20261010184340_SlackLifecycleReceipts, seeding existing records, then applying the expansion twice. Only that created database is dropped. Read the CI result before treating this gate as passed; local runs without PM_TEST_POSTGRES mark this check skipped. A successful fresh-model PostgreSQL API run is separate evidence from a real upgrade. Draft PR #32 is an implementation checkpoint and must not be merged while the coordinated release requirements remain open.

## CI baseline and preview gate

Run 38140326906 on cdd8ee5 passed all six CI jobs, including the explicit disposable upgrade from main. This satisfies the real PostgreSQL upgrade check at that baseline; multi-replica contention and remaining release gates are still open. Future UI batches run npm run build and npm run test:ui, inspect generated desktop/mobile screenshots, and show previews to the user before committing. CI retains synthetic previews as enterprise-ui-previews. This does not enable payment/provider flags or authorize claiming a complete coordinated release.

## Idle installation recovery and retention

Apply 20261011161936_WhatsAppMetadataRetention after durable delivery; it adds one nullable marker and four indexes, with no content rewrite or consent activation. Verify the latest real PostgreSQL upgrade and new maintenance tests in CI before release. The existing maintenance worker handles idle/inactive installations even with provider gates off. Live/unrecognized states and recent evidence survive; lost send acknowledgements never become retryable. Housekeeping is bounded and tenant-locked. Monitor backlog and preserve existing provider/payment gates; orphan cleanup, broader restart/replica coverage and the other release workstreams are still open. Prior 98095cb passed all six CI jobs in run 38154219373. A backend technical-reference image was shown to the user before this batch commit.


## Consolidated studios and durable upload recovery

The user confirmed that the full expanded scope must be complete before merging. The scope is not reduced to a foundation-only release. This checkpoint does not close the remaining inbox/calendar, verified customer actions, advanced routing or live payment/provider gates.

Resume, support and workflow studios now share a responsive visual hierarchy with restrained motion and reduced-motion support. Resume editing has collapsible sections, a save action near the current fields, real progress states and keyboard-selectable visual template cards. Workflow view selection is preserved in the URL across reloads; permission checks still determine access. No new animation dependency, external asset request or raster asset was added.

Private resume/certificate uploads persist a cleanup receipt before touching storage. The receipt initially defers cleanup for one day; the new pointer and receipt consumption commit in one transaction. An expired uploader cannot publish after cleanup starts. Ambiguous commit failures no longer trigger immediate storage deletion. Cleanup fences each receipt in a database transaction, checks references across all owners without retrieving personal content, preserves referenced originals/certificates/paid artifacts, and retries failed deletes. This covers new upload crash windows; it does not inventory historical bucket orphans or complete account-purge work. No new migration or environment variable is needed; the existing maintenance worker remains the scheduler.

Local validation: 32 focused backend checks passed, including nine upload-recovery cases and existing resume/certification/cleanup/access review. Frontend lint, unit tests, type/build and twelve synthetic browser checks passed. The browser checks include template keyboard selection, saved workflow-view reload, dark theme and reduced motion. An initial workflow-tab reset was observed before URL persistence; final checks passed with the persisted view. Actual desktop/mobile/light/dark preview images were shown before this checkpoint commit. The new revision still needs full CI verification; no AI bulk tests, real payments/customer messages/calendar writes, provider activation, merge or deployment occurred.


## Private inbox checkpoint - full release remains gated

The user requires the full expanded scope before merge. Verified baseline `425b884` passed all six CI jobs in run 38159780430: SQLite 1,284 passed / 2 intentional skips and PostgreSQL 1,281 passed / 5 intentional skips (1,286 cases each). The dedicated actual-main PostgreSQL upgrade and both 12-case transaction/credit checks also passed. AI burst testing remained disabled.

This checkpoint adds optional, per-person Gmail/Outlook inbox metadata and conversation reading. Inbox access defaults off and requires explicit read consent. Each request uses the person's own mailbox, rebuilds current workspace authorization before and after provider reads, and fences the connection to the exact encrypted refresh credential used to obtain the access token. Disconnect, reconnection, scope loss or revoked membership prevents returning content. Message/thread identities are checked; arbitrary mailbox/host URLs cannot be supplied.

Reads are bounded to twenty metadata items per page, ten displayed thread messages, 20,000 characters per body and 60,000 aggregate body characters. Metadata transport is limited to 64 KiB and full thread transport to 1 MiB, with a twenty-second request deadline. Gmail metadata fetches use at most four concurrent HTTP reads and no concurrent DbContext access. Cursors are encrypted, owner/workspace/provider/connection-bound and expire after ten minutes. Provider HTML is not rendered; absent plain-text bodies and truncated conversations are explicitly identified. No automatic AI sharing, attachments, sends, background polling or durable email-body storage is introduced. Provider clients suppress transport logging and refuse redirects. Google consent/profile responses are also bounded.

The private inbox UI loads only on explicit request, clears content on account/connection changes, cancels superseded requests and keeps mailbox content out of persistent browser storage. Light/dark/mobile layouts and keyboard message selection extend the existing synthetic UI suite. This does not complete summaries, attachment workflows, Microsoft calendars, attendee availability, AI scheduling, advanced support routing, account purge, payment validation or controlled provider activation. Six grouped release workstreams remain open; PR #32 remains draft, unmerged and undeployed.

Frontend lint, type-check/build, all 85 unit tests and fifteen synthetic browser checks passed. Updated desktop/mobile/light/dark inbox previews were shown before commit. EF reports no pending model changes. Sixty focused backend checks passed; the final owner-isolation/migration subset passed all 24 cases (overlapping the same suite). The new commit's full CI results remain pending. No AI bulk tests or live provider/payment calls occurred.

Consent review also confirms that unrequested provider scopes are not promoted into inbox access during callback or refresh; Microsoft reconnection preserves only previously consented reading while its deployment gate remains enabled.


### Exhaustive endpoint regression follow-up
Full CI on 97d6adf found a missing-message query reaching thread validation as null and returning HTTP 500 during the existing exhaustive team-scope crawl. Required message references now reject null/blank values as normal 422 validation errors before any provider request. Direct missing-parameter regressions are included; the exhaustive isolation test remains enabled. The follow-up passed all 27 local inbox/team-scope checks, including the unchanged exhaustive crawl and missing-parameter cases. A labeled technical reference was shown before commit. Follow-up full CI remains pending. The four non-database CI jobs passed on 97d6adf; its SQLite suite had one failure, 1,304 passes and two intentional skips. No coordinated release or deployment is claimed.


## Summary activation and release gate
Review the additive GroundedInboxSummaryReceipts migration and exact-head PostgreSQL/main-upgrade CI before deployment. Do not enable PersonalInboxSummaries, Microsoft or WhatsApp until their controlled verification gates pass. A generation reserves credits in a short committed transaction before calling AI. Completion writes the encrypted owner receipt and settles credits atomically. Recover interrupted work by reading its operation receipt; never retry with a new operation ID merely because a response was lost. Shared credit recovery expires abandoned twenty-minute holds without repeating inference. Confirm maintenance removes expired results while preserving billing records.

The user's full expanded scope is still the merge condition. Successful checks for this batch are not proof of production access, semantic accuracy, full expanded implementation or a Railway deployment.


## Attachment gate
Keep the attachment gate off until the controlled own-mailbox metadata/raw-file contracts are verified for configured Gmail and Microsoft accounts. Review observed memory and provider latency before setting deployment capacity; the per-file 2 MiB bound is not a measured concurrency guarantee. Verify reconnect/revocation, exact-size mismatch, unsupported reference/item kinds and interrupted browser navigation using controlled data. No new migration or background file storage is introduced. Account, calendar, commercial and final deployment gates remain open; the user's full expanded scope still applies before main merge.

## Private email review batch rollout

Deploy the API and web bundle together. Email rewrite requests must include the positive credit price shown at consent; the backend rejects missing prices with validation errors and changed prices with AI_EMAIL_CHANGED before model calls or credit holds. Older web clients that omit the price must reload the current frontend. No migration, new environment variable or provider gate change is required.

Verify draft refresh removes private content after denied access, same-address account reconnection retires inbox content and open confirmations, and read-only reload recovers accepted/unknown send receipts without dispatching. Never reset sending/unknown rows to retry. Automated provider reconciliation and durable standalone email-rewrite operation receipts are still separate release work; a failed rewrite currently requires checking the saved draft. Keep controlled Google/Microsoft provider activation and semantic-quality evaluation gates intact. All previews use synthetic data; no live provider readiness is implied.
