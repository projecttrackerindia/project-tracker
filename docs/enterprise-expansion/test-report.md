# Enterprise expansion verification — implementation checkpoint

Local branch: feat/enterprise-resume-support. No merge or production deployment has been performed for this expansion.

Verified local results:

- Initial resume/certification tests: 5 passed.
- Resume cash-export and support access tests: 7 passed.
- Private file/badge/reminder checks: 9 passed with one source-review guard failure; the intentional expiry-maintenance bypass was added to the reviewed list.
- Combined resume, purchase, support, certification, workflow, source-review and existing AI operations checks: 21 passed, zero failed (enterprise-workflow-focused.trx).
- Follow-up after exact approval previews: 15 passed, zero failed (enterprise-approval-preview.trx).
- Combined imports, resume/source, purchase, certification, support/workflow and existing work checks: 29 passed (enterprise-isolated-import.trx).
- Corrected compressed-PDF fixture and parser safety checks: 16 passed (enterprise-parser-safety-fixed.trx). The initial fixture exceeded the upload limit; the corrected fixture exercises decompression inside the child process.
- Workflow schedules, immutable revision restoration, certificate checks and source-review guard: 15 passed (enterprise-schedules-and-caps.trx).
- Frontend TypeScript and Vite production build passed after upload accessibility and cancellation UI changes.
- Current resume/support/work/source checks: 32 passed (enterprise-current-focused.trx), including staff-only routing fields.
- Durable cleanup, certificate, workflow, owner/tenant guard and resume checks: 19 passed (enterprise-durable-cleanup.trx). Storage-failure retry and immediate original-download revocation were verified.
- Existing frontend regression suite: 72 passed, zero failed.
- Word export validation initially identified two formatting-order failures. After correction, branded and clean Word schema validation and unsupported-PDF-character checks all passed.
- Broader offline backend subset: 675 passed, two skipped, zero failed (enterprise-non-ai-regression.trx), duration 8 minutes 34 seconds. Filter: FullyQualifiedName!~Ai&FullyQualifiedName!~LocalModel&FullyQualifiedName!~LocalWorkflow. This excludes matching test names as well as AI classes; it is not the full suite.
- Final frontend TypeScript/Vite production build passed after responsive preview watermark changes.
- Synthetic browser checks passed at 1440-pixel desktop and 390-pixel mobile widths for resume/support screens: no horizontal overflow, no page errors, upload input keyboard-focusable. The workflow canvas loaded. Fixtures intercept API calls and block external requests; this is layout evidence, not a production integration test. Artifacts are in .enterprise-browser/.
- Release publish contains the worker DLL, runtime configuration and dependency manifest in document-import/. Linux execution is still pending.

The focused API tests run on disposable SQLite databases created with EnsureCreated. Fresh API tests validate the current model, not the full PostgreSQL migration chain. Providers are mocked. PDF exports are parsed to check content/branding; DOCX headers are inspected for watermark XML. These checks do not prove visual Word rendering, international shaping or production payment readiness.

Covered behaviors include owner isolation, approval/version conflicts, template caps, corrupt/compressed document rejection, separate original provenance, AI-credit release/replay, captured-payment recovery/refunds/identical artifacts, requester/staff separation, ticket idempotency, badge opt-in, personal reminder destination/deduplication, stale organizational outcomes, acyclic workflow validation, paused approvals, removed publisher membership, foreign-tenant run denial, stale confirmation rejection and SLA event deduplication.

Remaining verification: workflow lease-contention tests; remaining backend tests and PostgreSQL upgrade/transaction checks; deeper component accessibility and browser interaction coverage; Linux isolated-parser execution; exact font/watermark rendering; external OAuth/signature/identity/outbox adapters and mocked confirmed productivity operations. No bulk AI tests or real external sends/calendar writes have been run.
## Support history and dashboard continuation
- Final focused run: 10 passed, 0 failed, 0 skipped (support-history-metrics-final.trx), including existing durable workflow regressions.
- New scenarios cover 60 public replies interleaved with 60 private notes, disjoint complete pages, staff visibility, foreign-tenant rejection, invalid offsets and changed-version rejection.
- Metrics verify empty foreign-tenant counts, completed on-time/late outcomes, cancelled work exclusions and resolution clocks paused before deadline.
- Frontend typecheck and production build passed with the new history and dashboard components. No live AI/provider calls or bulk AI tests were run.
- This is SQLite verification. PostgreSQL/provider activation and the other coordinated release gates remain pending.

## Reviewed routing and staged escalation
- 14 passed, 0 failed, 0 skipped: support-routing-escalation.trx (routing, ticket, workflow and query-filter guard scenarios).
- Verified workload ordering, zero-capacity/guest/inactive exclusions, tenant isolation, project relationships, explicit confirmation, stale versions and no-candidate ownership preservation.
- Verified the first escalation assignment waits for approval; the second stage waits until due, requires fresh approval and does not assign its recipient when rejected.
- Production frontend build passed with the routing review and staged escalation editor. No AI/provider load or real customer-message tests.
- No new migration in this phase. PostgreSQL contention and external integration activation remain release gates.

## Durable Google OAuth continuation
- 26 passed, 0 failed, 0 skipped: google-oauth-durable-final.trx, covering Google OAuth safety, existing Calendar integration, project meetings and tenant/query-filter guards.
- Browser-proof absence/mismatch, single-use and concurrent callbacks, safe redirects, reconnect updates, removed membership, expiry/caps/hash storage and partial scope handling are tested against a fake Google provider.
- The new schema was exercised through fresh EnsureCreated SQLite test databases. Frontend production build passed, including the reconnect/permission status UI.
- The initial new removal test used a Free workspace with only one seat; the fixture now explicitly upgrades before adding the member.
- No live Google requests, customer invitations, paid calls or bulk AI tests. PostgreSQL deployment/upgrade verification remains pending.

## Private email and optional Gmail continuation
- 32 passed, 0 failed, 0 skipped: personal-email-final.trx (private email, OAuth safety, Calendar integration, project meetings and query-filter tests).
- New scenarios cover owner/workspace isolation, metadata-only listing with private detail retrieval, header injection, version conflicts, disabled mail, exact scope, sender mismatch, explicit confirmation, concurrent single dispatch, Unicode MIME folding, accepted replay, erased content retaining receipts/rate history, unknown outcome blocking retry, missing sender/refresh token preserving the old grant, AI credit settlement/replay and invalid suggestion release.
- Frontend production build passed. Existing frontend suite: 72 passed across 10 files.
- A headless Edge check with blocked external requests verified private draft saving, full sender/recipient/message review, cancellation without dispatch, one confirmed request, readable immutable receipt retrieval and no horizontal overflow at 1440px and 390px. Fixed missing accessible input names and preserved newlines/long-address wrapping in confirmation dialogs.
- EF reports no model changes since the new migration; fresh SQLite tests exercise the current model through EnsureCreated. PostgreSQL upgrade/contention and production OAuth/provider readiness remain unverified.
- All provider/model responses in these checks are fake. No bulk AI testing, live email, customer messages or production configuration changes.
Visual follow-up: fixed the draft summary button height/text containment, added a 180px resizable message editor, used a narrower desktop library column with mobile stacking, and aligned the Google connection panel to the available width. The production build and repeated fake-provider browser interaction checks pass, including summary containment and editor height.

Separate tenant tripwire run: personal-email-tenant-guards.trx, 2 passed, 0 failed, 0 skipped. It verifies every organization-owned entity is filtered or explicitly reviewed, and inaccessible cross-project blockers do not leak details. Combined with the separate 32-test run, this phase has 34 distinct passing backend checks.

## Microsoft Outlook and SQLite upgrade continuation
- Final focused run: 31 passed, zero failed/skipped (microsoft-productivity-final.trx). It covers Microsoft OAuth/send, provider-neutral email, Google OAuth/Calendar and tenant/query-filter guards.
- Microsoft cases cover disabled setup, browser proof, concurrent callback consumption, PKCE, protected tokens, reconnect isolation, partial scopes/missing refresh/profile rejection, removed membership, cross-organization credentials, exact sender, concurrent single dispatch, accepted replay, original sender retention and unknown outcomes.
- Shared AI rewriting is checked for both providers with fake responses, existing credit settlement and no email dispatch. Membership revoked during refresh prevents sending.
- A representative previous integration schema is built from the actual earlier migration operations on disposable SQLite. The real startup expansion upgrader applies all nine reviewed additive migrations twice and preserves an existing Gmail receipt/content/version; provider becomes google and historical sender remains null. This is not a full production PostgreSQL/core-schema upgrade test.
- An initial attempt to run the entire historic migration chain on SQLite failed on existing PostgreSQL-specific SQL. The corrected test exercises the supported additive SQLite startup path. Earlier report wording claiming fresh SQLite tests ran migrations has been corrected: the API fixture uses EnsureCreated.
- Existing frontend suite: 72 passed across ten files; TypeScript/Vite production build passed.
- Mocked headless Edge checks passed at desktop 1440px and mobile 390px for Gmail acceptance, Microsoft acceptance and unknown Microsoft outcomes. Provider choice, complete sender/message review, cancellation, one explicit confirmation, receipt sender, blocked resend, summary containment, editor height and absence of page errors/overflow were checked. External requests were blocked.
- EF reports no pending model changes. No live providers, paid model requests, bulk AI testing, customer messages, production configuration changes, merge or deployment.
- Remaining coordinated release gates include WhatsApp/inbox/calendar features, provider recovery/accounting, PostgreSQL upgrade/contention, Linux import execution and visual Word rendering.

## Durable personal calendar continuation
- Final focused backend run: 45 passed, zero failed/skipped (personal-calendar-final.trx). Includes private calendar, existing project meetings/Google Calendar, Google OAuth/mail, query-filter/tenant guards and representative SQLite upgrade checks.
- Verified private owner/workspace isolation, disabled manual proposals, complete-availability rejection, changed account, explicit confirmation, concurrent single dispatch, overlapping proposal fencing, exact provider read-back, lost-response reconciliation without another POST, changed provider content, revoked membership and reconnect during token refresh.
- New migration: 20261011065223_PersonalCalendarProposals. The actual SQLite startup upgrader applies the tenth additive migration twice over representative prior integration tables and retains the existing Gmail receipt. Full PostgreSQL/core-schema migration verification is still pending.
- Initial calendar fixtures exposed Windows invariant-globalization zone resolution; validation now uses the existing NodaTime IANA database. An overlapping-race assertion was corrected to inspect errors only on unsuccessful API results.
- Existing frontend suite: 72 passed in ten files. TypeScript/Vite production build passed.
- Mocked Edge checks passed at 1440px and 390px for saving, availability, exact account/notes/times review, cancellation without write, one confirmation, uncertain outcome with no resend, read-only recovery, full receipt detail and no horizontal overflow/page errors. All external requests were blocked.
- EF reports no pending model changes. Explicit-offset input, invalid zone/duration rejection and verified receipt erasure are covered. No bulk AI tests, live calendar writes, customer invitations, production configuration changes, merge or deployment.
- Scope is personal primary-Google-calendar time blocks with no attendees. Existing project-meeting mutation durability, Microsoft calendars, inbox/thread/attachments, WhatsApp and the coordinated production gates remain unfinished.

## WhatsApp inbound foundation verification
Final focused backend run: 27 passed, 0 failed, 0 skipped; report backend/src/ProjectManagement.Tests/TestResults/whatsapp-foundation-final.trx. Filter: WhatsAppGatewayTests, SlackIntegrationTests, MicrosoftMigrationTests, TenantIsolationGuardTests and QueryFilterBypassGuardTests. This includes 13 new WhatsApp tests; it is not a full-suite result and is not added to overlapping historical counts.

Covered: disabled reception/installation/sending, exact challenge and raw-body signatures, body mutation, two independent tenant mappings, mismatched WABA/phone/app, protected fixture tokens, personal/member denial, subscription failure, duplicate and concurrent callbacks, local disconnect isolation, bounded lists and explicit UTC offsets, expired metadata cleanup, old/future/preinstallation events, malformed/oversized envelopes, whole-envelope validation before writes, and reserved phone mapping after disconnect. The actual additive SQLite startup upgrade runs twice and preserves prior Gmail receipts.

Frontend: production TypeScript/Vite build passed; existing frontend suite 72 passed in 10 files. Mocked Edge browser check passed at 1440px and 390px: plan guidance, unavailable installation, conditional diagnostic fetch, cancelled disconnect, one explicit disconnect, no page errors or horizontal overflow. Screenshots were inspected; every external request was blocked and all APIs were synthetic.

EF reports no pending model changes. Migration contains only new tables/indexes and is in the reviewed SQLite additive allowlist. PostgreSQL execution/replica contention, current official Embedded Signup, real provider configuration, verified contact linking, live messages, idle physical-retention cleanup and the other coordinated release gates remain unverified/unimplemented. No bulk AI testing or live customer messages occurred.

## Embedded Signup installation verification
- Final focused backend run: 37 passed, 0 failed, 0 skipped. Report: backend/src/ProjectManagement.Tests/TestResults/whatsapp-installation-final.trx. Filter: WhatsAppInstallationTests, WhatsAppGatewayTests, MicrosoftMigrationTests, TenantIsolationGuardTests, QueryFilterBypassGuardTests. Counts overlap historical reports and are not cumulative.
- Coverage includes two independent organizations, token isolation, replay, wrong browser/user/tenant, configuration rotation, invalid or incomplete assets, lost provider responses, permission/subscription changes during verification, late completion after disconnect and expired-token reconnection. All provider traffic uses the fake HTTP adapter.
- Backend API build passed with zero warnings/errors. EF reports no pending model changes. The real SQLite startup upgrader runs twice over the prior WhatsApp migration schema and preserves existing mapping/token rows with unknown expiry. PostgreSQL upgrade/contention remains unverified.
- Frontend production build passed; 81 tests passed across 11 files, including nine SDK contract tests.
- Mocked Edge installation/cancellation completed at desktop and 390px mobile widths under the actual nginx CSP, with no browser errors or horizontal overflow. The synthetic SDK tests the two-click flow, lazy loading and rejection of a forged origin. Screenshots and script are local review artifacts under .enterprise-browser; this is not a live Meta SDK/account validation.
- No bulk AI tests, real messages, customer asset writes, live OAuth exchanges or production configuration changes were performed.

## Private WhatsApp contact proof verification
- Final focused backend run: 54 passed, 0 failed, 0 skipped. Report: backend/src/ProjectManagement.Tests/TestResults/whatsapp-contact-final.trx. Includes contact, installation, gateway, prior-schema migration and tenant/query-filter guard tests. Counts overlap earlier reports and are not cumulative.
- Contact tests exercise independent tenant fingerprints for the same phone, owner-only masked retrieval, active membership/plan/gate checks, explicit account-link consent, protected storage, wrong sender/signature/tenant, stale/replaced/cancelled codes, replay, same-envelope competing claims, expired fingerprint release, disconnect/reconnection/configuration fences and rate caps that survive removal.
- Actual prior Gmail and WhatsApp schemas upgrade twice through the real SQLite startup upgrader; existing receipts/mappings remain intact and the new contact table is present. The separate two-test migration rerun is included in the final 54-test result. PostgreSQL upgrade and replica contention remain release gates.
- Frontend: 81 tests passed across 11 files; production TypeScript/Vite build passed. Mocked Edge verified disabled admission, explicit consent, masked results, in-memory code handling, refresh, confirmed unlink and desktop/mobile layout under production CSP. Zero live provider calls or actual customer messages.
- Browser verification found a responsive remount that erased the code. The corrected flow keeps it in the existing user/workspace-scoped memory cache until expiry/removal; sign-out and workspace changes clear that cache. Full page reload still requires a new code if it has not already been sent.
- EF reports no pending model changes. New additive migration: 20261011093926_WhatsAppPrivateContactLinks. Existing unrelated test-assembly nullable/xUnit warnings and Vite configuration warnings remain; these checks do not claim full-suite or production activation success.
- This proves private member phone linking, not external-customer authorization, notification consent or messaging readiness. No AI bulk testing was performed.

## Separate WhatsApp notification consent checkpoint
- Focused backend run: 71 passed, 0 failed, 0 skipped; whatsapp-notification-consent-final.trx. Filter includes WhatsAppContactTests, WhatsAppInstallationTests, WhatsAppGatewayTests, MicrosoftMigrationTests, TenantIsolationGuardTests and QueryFilterBypassGuardTests. Counts overlap earlier runs and are not additive.
- New coverage verifies independent purpose acceptance, categories, validated IANA/midnight-crossing quiet hours, owner/organization isolation, version conflicts, concurrent single grant, withdrawal after gate/plan disablement, removed membership and phone/installation/rotation/token/age invalidation. Phone proof cannot automatically opt into messaging, and saving consent cannot activate delivery.
- Representative prior verified-contact schema is constructed from its actual migration, then the real SQLite startup upgrader runs twice. Phone ownership/proof and admission counters are preserved; notification purpose remains null, categories false and version zero. Quiet-hour defaults are 22:00/08:00. This is not a full PostgreSQL/core-schema migration test.
- Frontend production build passed; existing suite passed 81 tests across eleven files. No new runtime dependency was added. EF reports no pending model changes.
- Production-build Edge checks with production CSP and all external requests blocked passed at 1440px and 390px. They cover explicit account-link consent, masked verification, separate notification purpose/category acceptance, zone/quiet-hour submission, delivery-disabled status, independent revocation, confirmed phone removal, no horizontal overflow and no browser page errors. Screenshots were inspected; local browser artifacts remain untracked.
- After strengthening the existing expired-phone-owner cleanup assertion to include notification revocation, the contact suite was rerun separately: 33 passed, 0 failed/skipped; see whatsapp-notification-consent-refined.trx. This repeat is not added to the 71-test count.
- No AI bulk tests, real provider requests/messages/calls/calendar writes, production variable changes, merge or deployment. Six coordinated-release workstreams remain open. Voice agents are a documented follow-on design, not implemented calling functionality.

## Read-only WhatsApp provider health checkpoint
- Focused backend run: 95 passed, 0 failed, 0 skipped; whatsapp-provider-health-final.trx. Filter includes WhatsAppHealthTests, WhatsAppInstallationTests, WhatsAppGatewayTests, WhatsAppContactTests, MicrosoftMigrationTests, TenantIsolationGuardTests and QueryFilterBypassGuardTests. This is not a full-suite result or an additive historical total.
- Covers default-off admission, current token/app/lifetime and data-access expiry, granular WABA grants, exact assets/phone proof, subscribed app, revoked/missing permissions, two organization isolation, no premature network requests, sanitized oversized/malformed/redirect/paging/network outcomes, rate limits, parallel claims, expired lease recovery and stale-result hiding.
- In-flight disconnect, connection epoch/configuration changes, lost membership and cancelled subscription cannot persist healthy observations. Disconnect clears health/claims while preserving the attempt cooldown. No provider mutations or messaging are performed by this adapter.
- After strengthening exact app-secret proof validation in the fake provider and adding the no-scheduled-expiry case, the health suite passed 25/25, zero failures/skips; whatsapp-provider-health-refined.trx. A provider response with no scheduled expiry cannot extend or erase a previously recorded expiry. This repeat overlaps the earlier run and is not added to 95.
- Representative old WhatsApp installation tables are rebuilt from actual migrations; the real fifteen-migration additive SQLite startup path runs twice, preserves tenant/token ownership and leaves all new health claims/observations null with unchecked state. Fresh API fixtures use EnsureCreated. Full PostgreSQL upgrades/replica contention remain unverified.
- TypeScript/Vite production build passed; existing frontend suite passed 81 tests across eleven files. EF reports no pending model changes.
- Production-CSP Edge checks passed at 1440px and 390px for default-off checks, no provider reads on opening settings, missing-permission diagnostics, passed-read delivery-disabled wording, stale claim hiding, confirmed disconnect and no page errors/horizontal overflow. Screenshots were inspected; APIs were synthetic and all real external requests were blocked.
- New deployment variable is WhatsApp__HealthChecksEnabled=false. No production variables, accounts or records changed; no real messages/calls/calendar writes, AI bulk tests, merge or deployment. Strict live provider response/granular-grant validation, phone registration and webhook delivery remain controlled rollout gates.

## Template contract checkpoint validation - 11 October 2026
- Focused backend run: 130 passed, zero failed/skipped (WhatsApp template/health/contact/installation/gateway, MicrosoftMigration, tenant and query-filter guards). TRX: whatsapp-template-final.trx. No live provider or AI calls. Covers default-off/read-only checks, exact approval/locale/body/category, missing/pending/paused/rejected templates, variables/buttons, ambiguous/unbounded responses, independent organizations, access/plan/health gates, disconnect/epoch/configuration/membership/plan/health/gate/lease races, duplicate claims/cooldown, stale hiding and abandoned-claim recovery.
- Actual prior WhatsApp additive SQLite upgrade runs twice; tokens/tenant ownership survive and all new template state remains unchecked. Full PostgreSQL upgrades/contention are still unverified. EF reports no pending model changes.
- Frontend: 81 tests across eleven files passed; TypeScript/Vite production build passed. Production-CSP mocked Edge checks passed on desktop 1440px/mobile 390px for disabled admission, no Meta calls on opening settings, customer setup/preview, missing-template guidance, approved-check delivery-disabled wording, stale-result hiding and no errors/horizontal overflow. Screenshots inspected.
- WhatsApp__TemplateChecksEnabled is a new default-false read-only gate. No production variables/records changed; zero actual messages/calendar writes/calls, AI bulk tests, merges or deployments. The coordinated six-workstream release is not ready.

## Durable WhatsApp delivery checkpoint - 11 October 2026
- Combined focused backend regression: 203 passed, zero failed/skipped; whatsapp-durable-delivery-final.trx. Includes WhatsApp delivery/template/health/contact/installation/gateway, support ticket/routing/resolution/workflow, notifications/work tasks, additive migration and tenant/query-filter guards. New delivery cases cover organization/token/recipient isolation, public versus private support messages, current-resource permission and mutation races, replay/recovery, quiet hours/DST/budgets, shared readiness caching, exact transport and signed receipt matching. No live provider or model calls.
- Initial fixture problems were corrected and the final combined run passed. The earlier 30-case run overlaps this result and is not added to 203.
- Frontend: 81 tests across eleven files passed; final TypeScript/Vite production build passed. Production-CSP mocked Edge checks passed at 1440px/390px: accurate activation wording, acceptance versus delivery, uncertainty/permission explanations, read-only history, no page errors/overflow, zero live provider calls.
- Additive prior-installation SQLite upgrades passed twice with ownership/tokens preserved and an empty new outbox. EF reports no pending model changes. Full PostgreSQL upgrades and multi-replica contention remain unverified.
- Delivery activation remains default-off. No AI bulk testing, customer messages/calls/calendar writes, production mutations, main merge or deployment. Controlled live contracts/phone/webhook validation and six release workstreams remain open.

## Export and CI continuation
All ten Word templates now carry a self-contained WordArt shape definition for the branded watermark. Section headings retain their following content and the templates with section rules use those rules in Word as well as PDF. Thirty focused resume/export/import/evidence/purchase/cleanup checks pass, including all ten branded and clean Word schema checks. The first strengthened watermark run exposed the missing shape definition; the fixed run passes. Optional local fixtures contain synthetic text only.

Visual Microsoft Word rendering remains unverified: the locally registered Word automation handler is WPS Writer and did not provide compatible automation. Those unsuccessful renderer probes are not counted as passing tests. No real payment was taken or checkout enabled.

Draft PR #32 runs the existing Linux CI, including isolated import tests and PostgreSQL API tests, with the optional AI burst benchmark off. Added an explicit PostgreSQL upgrade check from main's actual last migration, preserving existing account/workspace/notification rows and applying the full current chain twice in a randomly named disposable database. Local compilation passed and this check is explicitly skipped without PM_TEST_POSTGRES; its execution result must be read from CI before claiming success. An earlier CI lint error in SDK-code validation was corrected without weakening control-character rejection. Full final CI results are still pending at this checkpoint.

Final local frontend continuation: lint passes with no errors (existing warnings remain); 85 tests pass, including malformed/control-character SDK code rejection. Fair polling regression and query-filter guard pass 2/2; explicit nullable ordering avoids PostgreSQL/SQLite differences that could starve a new organization behind a full batch of older ones. These checks overlap prior runs; no combined sum is claimed.

## Verified Linux CI baseline and workflow preview continuation

Run 38140326906 passed all six jobs on cdd8ee5 (draft PR #32): API SQLite, API PostgreSQL, web checks/security audit, Docker builds, desktop tests and deployment-file validation. SQLite passed 1,264 tests with two intentional skips; PostgreSQL passed 1,261 with five intentional skips. The optional AI burst remains off. Counts overlap focused tests and are not added together. The disposable PostgreSQL upgrade from main's actual migration 20261010184340_SlackLifecycleReceipts passed, including preserved existing rows and a second migration application. Replica-contention and the other coordinated release gates remain open.

A fresh production-build browser preview exposed genuinely hidden workflow nodes: the controlled canvas discarded its measured dimensions while recreating nodes. Measurements are now retained separately from saved graphs, and only actual coordinate changes modify the draft. Shared field styles and selected-step highlighting improve desktop/mobile editing. Browser checks cover visible nodes/edges, keyboard and pointer selection, dragging, adding/editing a node, resizing, canonical save payloads and saved-coordinate reload. Resume/support previews also check mobile overflow and upload keyboard focus. All requests use synthetic responses under the production CSP; external requests are blocked. No live APIs, providers, payment or model calls are made.

Run npm run build then npm run test:ui from frontend. The pinned development-only Playwright dependency supplies Chromium in Linux CI (npx playwright install --with-deps chromium); PM_BROWSER_EXECUTABLE optionally selects a locally installed browser. Generated test-results/enterprise-ui screenshots/results are uploaded as enterprise-ui-previews and ignored by git. PM_UI_ARTIFACTS optionally selects another output folder. This is functional browser evidence, not full accessibility certification or live installation/provider validation.

The user requires actual desktop/mobile previews before each future batch commit. Local synthetic workflow previews were shown before this batch's commit; they are not deployed application screenshots. cdd8ee5 is the verified CI baseline; the next UI commit needs its own CI result. The expansion remains draft, unmerged and undeployed while the six grouped workstreams remain open.

Final local results for this UI batch: production build and lint pass (no errors; existing 78 warnings), 85 frontend unit tests pass, and the production-CSP browser run passes eight recorded checks including save/reload, with zero page errors or horizontal overflow. The pinned browser dependency is development-only and adds no browser code to the app bundle.

## Browser runtime follow-up

Run 38153383724 on f623e6d passed both API jobs (including the actual-main PostgreSQL upgrade), Docker images, desktop tests and deployment files. The web job passed lint/unit/type/build but its new browser fixture failed when Linux's UTC device timezone triggered the app's normal reminder-timezone PUT. The fixture intentionally rejects unexpected mutations. Pinning the browser timezone to Asia/Kolkata matches the synthetic user; all eight checks now also pass with Playwright's bundled Chromium, not only the locally installed Edge. The subsequent commit still requires its own Linux CI result.

Retention review also found an open production-hardening gap: WhatsApp receipt and outbox cleanup currently occurs during inbound/poll activity, so completely idle or disabled installations need separate bounded metadata maintenance. No retention policy or records were changed in this UI batch; this remains phase 5 work. In-flight and unresolved delivery evidence must be fenced from cleanup, and recently updated receipt evidence must survive for reconciliation.

## Idle WhatsApp metadata maintenance checkpoint

Added background WhatsAppMetadataMaintenance to the existing maintenance cycle and reused its tenant-scoped recovery/retention path during delivery polling. It runs independently of provider activation and active subscription: cleaning operational metadata does not grant integration access. Global scheduling returns only tenant IDs based on timestamps/states. Separate scopes and tenant-ledger transactions fence each batch; no message contents, recipient phone, token or business-resource data are read, and no provider or AI calls occur.

A pass selects at most ten installations, including inactive mappings, ordered by a persisted RetentionPolledAt marker so a backlog rotates between organizations. Each operation changes/deletes at most 100 rows. Expired preparation with no persisted attempt returns to the queue; expired queued notifications are suppressed. Lost send leases become unknown and remain non-replayable. Live leases and inconsistent/unrecognized states are retained. Normal recipient/permission/consent/provider gates still control any later delivery.

Deletion requires a recognized terminal state and every tracked creation/change/attempt/acceptance/provider-status timestamp to be older than thirty days. Recent callbacks or acknowledgements survive even when the row was created earlier. Recovery decisions update their timestamp and get a fresh retention window. Incoming receipt metadata uses its received timestamp. Installation ownership, token material, reserved phone mappings and user consent are preserved.

Migration 20261011161936_WhatsAppMetadataRetention adds nullable WhatsAppConnection.RetentionPolledAt and four indexes for retention ordering, tenant/created-time scans, expired queue work and expired leases. The SQLite additive migration allowlist now contains eighteen reviewed migrations. Repeat-upgrade checks preserve existing mappings/tokens and leave the polling marker null; EF reports no pending model changes.

Local verification: 177 focused tests pass, covering all WhatsApp regressions plus maintenance, prior SQLite upgrades, bypass review and personal-file cleanup. The eleven new maintenance cases cover disabled/inactive installs, recent-evidence windows, abandoned reads/sends, live/unknown states, bounded repeated cleanup, private tenant separation, concurrent independent scopes and eleven-organization rotation. Concurrent scopes exercise database fencing but do not prove every cross-process replica/restart scenario. Real PostgreSQL upgrade and execution for the new migration must be confirmed from the next CI run.

All six CI jobs passed on prior revision 98095cb in run 38154219373, including the Linux browser previews and actual-main PostgreSQL upgrade. That evidence is a baseline, not the result of the new retention code. The technical batch-reference image was shown before committing; no new product UI is added in this backend batch. No AI bulk tests, real customer/provider sends, main merge, production variables or Railway deployment were performed. Six grouped release workstreams remain open; physically orphaned mappings/files, other integration retention, wider restart/replica coverage and the remaining provider/payment/productivity gates still require work.
