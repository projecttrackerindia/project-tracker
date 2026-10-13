# Module delivery order

The user selected individual module review on 12 October 2026. Every module must have a professional, futuristic UI: deliberate hierarchy, efficient use of space, coherent light/dark themes, responsive layouts, keyboard controls and restrained motion with reduced-motion support. Show actual built-app images before each batch commit. Do not sacrifice these requirements for speed. Demo screenshots must be labeled synthetic; they do not verify live integrations.

Individual review batches preserve the existing requirement to finish the expanded scope before the final main merge. The original six workstreams remain open where listed in implementation-plan.md; the ordered modules below are delivery slices of that scope. Voice remains a follow-on release.

| Order | Module | Status at this checkpoint |
| --- | --- | --- |
| 1 | UI and integration setup guides | Review batch bd5bf70 passed all six exact-head CI jobs |
| 2 | Personal inbox and email | Private compose, durable rewrite receipts and read-only Sent reconciliation implemented; controlled provider, semantic quality and wider retention/readiness remain |
| 3 | Resume builder | Studio/imports/branded exports exist; rendering, Linux parsing and authorized evidence verification remains |
| 4 | Workflow studio | Visual studio and durable engine exist; deeper recovery/replica tests remain |
| 5 | Calendar and scheduling | Google private blocks and own Outlook availability exist; writes, attendee availability, AI scheduling and project-meeting recovery remain |
| 6 | Advanced support management | Tickets/routing previews/escalation foundations exist; business-hour/skill/availability routing and deeper SLA/quality work remains |
| 7 | WhatsApp customer workflows | Installation/member identity/outbox foundations exist; verified customer actions and controlled provider verification remain |
| 8 | Commercial billing | Credit ledger and gated resume checkout exist; top-up packs, tax and captured-payment reconciliation remain |

## Module 1

Workspace settings > Integrations > Webhooks, Slack & Teams now has a focused provider selector and a four-step guide. Guide choice is shareable in `?guide=slack|teams|json` and survives reload/back navigation. Provider selection preselects the correct format in the existing creation modal; opening guides or modals never sends. Existing webhook permission and plan checks are reused.

Slack workspace installation is explicitly separate from channel webhooks. The connection card distinguishes ready, pending configuration, upgrade required, connected, revoked/error and loading states. Retry replaces failed status reads; a failed saved-webhook read cannot masquerade as an empty list. Interactive Slack functionality stays unavailable as before. No hardcoded tenant, credentials, provider activation, migration or environment changes.

Orbit AI has a deliberate two-row toolbar, an existing animated vector mark and a compact remaining-credit ring with details on demand. The ring measures credit balance, not concurrency capacity. Rate caps are absent from the toolbar. Arrow/Home/End keys select eligible modes with one tab stop, skipping locked modes. Escape and outside dismissal work even immediately after opening Usage, without taking focus when the panel is closed. Existing Agent Tracker and Activity icons are already distinct and are covered by the browser check.

Visual artifacts: `.enterprise-browser/module-one-final/workspace/` contains actual production-bundle desktop/tablet/mobile/light/dark screens using synthetic APIs. The checks use production CSP, refuse unexpected writes and block external requests. No model calls, live customer messages, calendar writes, payments or bulk AI tests. No new runtime dependencies or raster assets.

## Module 2 — private email review batch

The first Module 2 batch creates a focused email studio with a saved-draft/receipt library, sender status, versioned edits, explicit credit-priced AI refinement, review-before-send and read-only accepted/unknown receipts. Mobile drafts use a horizontal strip rather than occupying the full writing area. Account cards share a responsive grid and direct inbox/studio links; failed connection reads have explicit recovery controls. Status timestamps use the person's configured time zone. Acceptance is not presented as recipient delivery.

User/workspace/grant changes retire in-flight draft responses and confirmations. Same-address Outlook reconnection also clears the inbox and downstream summary/attachment views. Denied mailbox/thread or draft-library reads remove previously displayed private content. Interrupted sends recover their recorded status through read-only retrieval; sending/unknown outcomes cannot be retried or deleted. Email AI requests now include the exact reviewed credit price; changed/missing prices are rejected before inference or reservation.

No new migration, runtime dependency or environment variable. Deploy the API and frontend together: old clients that omit the reviewed AI price receive validation errors. Provider activation remains subject to the existing controlled-account gates. This batch does not implement automated provider Sent-folder reconciliation or a durable standalone email-rewrite operation receipt; users reload the saved draft after a failed rewrite, and the backend retains version and credit safeguards. These recovery improvements, controlled provider verification, semantic-quality evaluation and broader retention/readiness remain release work. Manual reading never shares email with AI; rewrites and summaries require separate consent.

Initial planning allowance: 8–16 focused engineering hours for the remaining Module 2 UI/recovery/regression work, not a guaranteed deadline. Provider verification may add elapsed time and depends on authorized configured test accounts. Microsoft remains disabled until configured and verified; no AI bulk testing is permitted.


## Module 2 - durable email recovery batch

Rewrite admission now commits an owner-scoped operation receipt and its shared credit hold before inference. Completion publishes the new draft version, encrypted saved result and credit settlement in one short transaction. GET recovery and same-reviewed-operation replay never start inference or another credit reservation. A changed operation payload conflicts; older wording is explicitly identified and cannot overwrite newer saved or unsaved edits. Results expire after 24 hours, and maintenance removes up to 1,000 expired receipts per run while the financial ledger remains authoritative. Abandoned twenty-minute holds use the existing credit recovery worker.

Confirmed sends persist a private correlation marker before dispatch. An explicit Check provider Sent action uses separately consented inbox-read access and fixed provider GET routes only. A matching Sent copy must agree with the marker, sender, sole recipient, subject and send time. Gmail searches the recorded Message-ID; Outlook inspects at most twenty entries in a bounded confirmation-time window and fetches matching metadata. Missing, incomplete, ambiguous or changed-access evidence remains uncertain and cannot authorize another send. Verification records provider acceptance, never recipient delivery. Older receipts without a marker require manual checking.

Migration: 20261012060025_DurablePersonalEmailRecovery adds PersonalEmailRewrites, nullable DispatchKey/ReconciledAt and reviewed indexes. Legacy draft contents, versions, send status and existing provider IDs remain intact. The SQLite additive upgrade is repeatable. No new environment variable or runtime dependency; existing optional inbox gates/scopes and provider activation gates are reused. API/web must roll out together after migration review and exact-head CI.

Validation: 109 combined backend cases passed, followed by two receipt-integrity cases and a final overlapping 42-case email recovery/migration subset. All 87 frontend unit tests, lint (zero errors/79 existing warnings), TypeScript/build and 70 synthetic production-CSP browser checks passed (20 enterprise, 21 workspace, 29 email). No page errors or measured overflow. Final real-app images are in .enterprise-browser/module-two-recovery-final/email and were shown before commit. Previous checkpoint 35b5eae passed all six CI jobs in run 38208931110. The new revision requires its own CI; no deployment or final main merge is claimed.

Module 2 remains open for controlled Google/Microsoft contracts, semantic-quality evaluation and wider retention/readiness. The remaining modules and six grouped expanded-release workstreams stay open. No live emails, paid AI calls, calendar writes, payments or bulk AI tests were run.

## Module 2 - response retirement and CI recovery

CI run 38212291982 on 1d0210b passed the API/SQLite (1,412 passed, two intentional skips), desktop, Docker and deployment-file jobs. PostgreSQL passed its actual-main migration upgrade and transaction/credit stages, then the full suite reported one timestamp-precision assertion failure (1,408 passed, five intentional skips). Web failed when a synthetic access revocation raced the preceding receipt check's unfinished refresh. These failures are recorded rather than treating local success as release readiness.

The receipt test now waits for operation completion before revoking access. Its PostgreSQL timestamp assertions tolerate only sub-microsecond storage precision loss; all other receipt data must remain identical. A separate controlled browser regression reproduced a real late-response issue: a delayed rewrite could restore private content after access denial and successful library recovery. Operation/access generations now retire that response permanently. A fresh explicit selection still works, and durable backend receipts remain recoverable without another inference or charge.

No migration, new environment variable, dependency or provider activation. The follow-up requires its own exact-head CI. Controlled provider/semantic verification and broader retention/readiness still keep Module 2 open; main remains unmerged.

> **Update (Oct 2026):** Support Center screens, active `/api/v1/support/*` endpoints, application services and background worker are removed. Operations is the support desk. Applied migrations and historical storage mappings remain for data compatibility; no historical support data is deleted. Native planned leave has an additive migration and separate review/confirmation flow. Release verification is recorded in `docs/AGENT-OPERATIONS-LAYOUT-LEAVE.md` and the release report.
