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
