# Enterprise expansion security review — ongoing

## Boundaries verified by focused tests

- Resume versions, original files, certificates and purchased artifacts are owner-only; organization administrator status does not grant access.
- Member profile badges first require target membership in the current workspace. Guests receive no badges. Only opt-in name/issuer/expiry/self-reported status is projected; credential identifiers, verification links and attachments stay private.
- Expiry maintenance deliberately bypasses owner filters to select active owners, then delivers only into their personal workspace. Default delivery is in-app; repeated stage reminders are deduplicated.
- Resume evidence requires independent requester acceptance, not merely completion. Reads, approval, AI refinement and exports check current source access and work version. Frontend local drafts remount on account/workspace changes.
- Support requester views exclude staff-only custom fields, handoff reasons and staff notes and cannot open another organization's tickets. Related IDs are disclosed only after checking both tickets. Duplicate message keys cannot change the original body or visibility.
- Workflow graphs have no arbitrary executable code, loops or unreachable nodes. Validation visits each node/approval state a bounded number of times. Total configured waits cannot exceed seven days.
- Each assignment/handoff consumes its own explicit approval. The preview identifies the target or handoff reason from the immutable revision. Current ticket/work versions must still match before execution.
- Background execution reconstructs active account, current membership, role overrides, module access and project scope. It never restores a historical administrator role. Atomic database effects and node receipts prevent duplicate actions after rollback/retry.
- Workflow actions suppress recursive trigger emission. Events retain revision IDs from creation; republishing/disabling prevents pending old-revision actions.
- Cash exports bind a server-side order to one saved artifact; signature, capture, amount, currency, refund state and artifact hash are checked. The parent account row serializes preparation across API replicas. Test gateways never contact a real provider.

## Reviewed query-filter bypasses

MemberProfile.cs projects explicitly shared badge fields after workspace membership. BillingService.cs handles personal certification expiry delivery. WorkspaceExecutionPrincipal.cs rebuilds one saved principal's current membership and project scope. SupportWorkflowProcessor.cs scans only scheduling/lease/SLA metadata globally; business reads and mutations run in a fresh authorized executor scope. These files are included in the source-level bypass guard.

## Open release gates

- PDF, DOCX and certificate-image parsing now run in a separate process with a 10-second default deadline, a 128 MiB managed-GC heap budget and two admission slots per API process. Admission occurs before upload copying; inherited credentials are stripped. A compressed 256 MiB PDF regression is rejected and a following import succeeds. This is a managed-heap limit, not an OS limit on native allocations; retain container memory limits and verify the worker in the Linux deployment.
- AI resume validation rejects identity/contact changes and new numeric claims, but semantic fabrication cannot be excluded by these checks alone. Suggestions remain unverified and require review; stronger grounded transformation evaluation is still needed.
- PDF rendering rejects missing glyphs before producing an artifact or initiating a purchase; Word preserves the original Unicode text. Embedded PDF fonts support Latin/Greek/Cyrillic coverage, not full international script shaping. Word formatting XML ordering was corrected, and branded/clean exports now pass OpenXML schema validation. Visual Word/LibreOffice watermark verification remains a separate release check.
- Payment tax treatment, required accounting/invoicing, unknown-order reconciliation and production capture configuration remain activation gates. No live payment verification has been performed.
- Private-file pointer removal/replacement queues a cleanup receipt in the same database save. Storage failure retains a durable retry; download access is removed immediately. Account-level hard deletion, abandoned upload recovery and production storage monitoring need separate verification.
- PostgreSQL transaction/recovery tests, multi-replica contention, browser accessibility and full regression tests remain outstanding.
- External verified WhatsApp identity/signatures/outbox, inbox reading and durable calendar operations remain unfinished. Microsoft OAuth and explicitly confirmed personal Outlook sends are now implemented behind a disabled deployment gate. They remain disabled.

No credentials, private document bodies, raw provider replies or payment secrets should be added to audit metadata or release reports.
## Support history and metrics continuation
Queue staff access now requires both Work module Edit and WorkEdit, matching detail access; an assignee with only module View does not become staff. History authorizes the ticket on every page and filters internal notes before OFFSET/LIMIT. Version checks reject changed conversations, including changes during the query. Stable timestamp/ID ordering resolves timestamp ties. Metrics reuse filtered operational work and ReportsView; no unbounded message materialization or cross-tenant counts.

## Routing and escalation continuation
SupportRoutingService binds TenantMembers to the current tenant explicitly and reuses Insights workload authorization. Preview DTOs exclude email addresses and billing/cost fields. Linked projects require recorded ownership, membership or project-team membership for recommendations. No live availability, skills, task-effort forecast or global-optimal assignment is inferred. Failed/no-candidate routing preserves ownership. Synchronous assignments require explicit confirmation and exact ticket/work versions; publication approvals and current-principal execution remain authoritative for staged workflows. Provider messaging is not added by these controls.

## Provider OAuth callback foundation
Google state moved from non-atomic cache reads to hashed, browser-bound database attempts. Atomically consuming the attempt fences callback replay across replicas; active membership is rebuilt, and reconnection serializes on the active user row. Only five live Google attempts per user are admitted; expired metadata cleanup is bounded. Local return paths reject protocol-relative/backslash/control-character/fragment inputs, and query parameters are preserved when adding the outcome. Token and Calendar error-response bodies are no longer logged or attached to GoogleApiException. No Gmail scope is requested in this phase.

## Private drafts and confirmed Gmail dispatch
Owner and tenant filters protect both metadata and individual content; response caching is disabled. Metadata listing does not read all message bodies. Header injection, oversized input and stale edits are rejected. RFC 2047 subject folding preserves UTF-8 rune boundaries. AI generation shares only the explicitly approved draft with the configured provider; recipient remains fixed. New numeric/contact/link claims and malformed JSON are rejected, but semantic accuracy still requires human review.

The durable sending claim commits before network I/O. User-row serialization and version comparison fence competing confirmations across API instances; there is no automatic provider retry. Dispatch and response-body reads have an explicit combined deadline. Process interruption leaves a blocked sending record; lost/bad responses leave unknown. Browser cancellation does not erase the receipt. Audit metadata excludes recipient, subject, message content and raw provider response. Rate checks retain deleted receipt history. A mail grant without freshly resolved sender identity cannot overwrite the existing connection. Mail consent asks for gmail.send and userinfo.email only; previously granted Google permissions may also be returned by Google.
Mail reconnection additionally requires a fresh refresh token, preventing a new displayed sender from inheriting a previous account's refresh grant.

## Microsoft OAuth and shared email receipts
Microsoft uses browser-bound hashed state/proof, atomic callback consumption, protected PKCE verifier, fixed provider hosts and validated authority identifiers. Tokens are encrypted only on the backend. Partial consent, missing refresh grants and invalid profiles cannot replace a valid connection. Refresh updates compare the previous protected token so concurrent reconnection cannot silently overwrite a new account. Profile/token responses and token lifetimes are bounded and raw provider responses are not logged.

Shared send authorization rechecks active workspace membership after token refresh and before the durable claim. Confirmation captures the exact displayed sender, saved provider and version. Concurrent confirmations fence dispatch; Graph request IDs are retained only as tracing metadata and no message IDs or delivery results are fabricated. Timeout/crash outcomes block automatic retries. The sender on older receipts remains explicitly unknown; reconnecting does not rewrite existing receipt identities. Local disconnect is documented separately from remote consent revocation.

No live Microsoft credentials were configured or activated in this phase. Inbox/attachment access, calendar rights and organizational mailboxes are not granted.

## SQLite expansion startup upgrades
SQLite development databases do not run the historic PostgreSQL migration chain. SqliteEnterpriseUpgrade now applies an explicit list of the nine additive expansion migrations in a transaction, skipping existing tables, columns and indexes. It refuses raw SQL, destructive operations, table rebuilds and unreviewed migration types. Startup is repeatable and keeps existing private content. This does not upgrade arbitrary historic core-schema differences or replace PostgreSQL migration validation.

## Private calendar confirmation and recovery
Private metadata retrieval omits notes; owner/tenant filters prevent administrator or peer access. Saved content is immutable. Explicit account/version confirmation, fresh primary-calendar conflict checks and current membership revalidation precede a committed claim. Active-user row serialization and saved overlap checks prevent concurrent overlapping proposals by the same person within the workspace.

Provider requests use fixed hosts, combined per-request 20-second deadlines, bounded 64 KiB JSON bodies and no raw-response logging. Stable event IDs and private proposal/owner/workspace markers support read-back verification. No retry is sent after an uncertain write, including a lost response. Only exact matching event content/times marks success. No invitation recipients or AI provider access are introduced.

Google token refresh now reads untracked state, bounds response size/lifetime and uses comparison against the prior protected refresh grant before updating. A reconnect/disconnect winning during refresh prevents credential overwrite and blocks the subsequent action. A provider permission downgrade is rejected. Calendar instants use explicit UTC offsets; zone validation uses the existing bundled NodaTime data and works with invariant globalization.

Limitations: primary calendar only; conservative busy-event counting; no guarantee against a simultaneous event written outside this flow; unresolved missing/changed events need an administrator recovery design; project meeting mutations and Microsoft calendar actions remain pending.

## WhatsApp foundation review
A Meta webhook signature proves provider origin, not authorization of a person to access Project Tracker. The gateway never grants identity from a phone number, never sends a reply and never invokes Gemini. Raw bodies are processed in memory and are not persisted or logged by this service.

Global lookup bypass is confined to exact configured app ID plus signed WABA/phone IDs and installation metadata. Current tenant is established before scoped operations and restored in finally. The tenant ledger lock serializes disconnect and receipt admission; mapping and entitlement are checked after acquiring it. Provider message IDs have a unique DB constraint and retries are deduplicated. Provider timestamps before installation, over 30 days old or more than five minutes ahead are discarded.

Both management and receipt reads check current organization admin membership and active user state. Personal workspaces and ordinary members cannot manage the integration. An active subscription with the central entitlement is required for reception and diagnostic reads. Local disconnect remains possible after eligibility expires, erases usable credentials and preserves a reserved mapping. Remote consent revocation is a separate customer step.

Remaining activation gates: approved official Embedded Signup, app/asset ownership and token verification, protected token persistence, contact identity proof, consent, template/24-hour rules, durable outbox and provider recovery, idle retention/account-purge behavior, ingress/proxy logging review, and PostgreSQL contention verification. Do not activate live reception until these checks and controlled-account verification are complete.
