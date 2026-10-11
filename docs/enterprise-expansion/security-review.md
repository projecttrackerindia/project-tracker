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
- External verified identity, WhatsApp signatures/delivery outbox, Microsoft OAuth and confirmed productivity operations are not implemented at this checkpoint. They remain disabled.

No credentials, private document bodies, raw provider replies or payment secrets should be added to audit metadata or release reports.
## Support history and metrics continuation
Queue staff access now requires both Work module Edit and WorkEdit, matching detail access; an assignee with only module View does not become staff. History authorizes the ticket on every page and filters internal notes before OFFSET/LIMIT. Version checks reject changed conversations, including changes during the query. Stable timestamp/ID ordering resolves timestamp ties. Metrics reuse filtered operational work and ReportsView; no unbounded message materialization or cross-tenant counts.
