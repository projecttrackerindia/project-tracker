# Enterprise expansion API contracts — implementation checkpoint

All routes use existing authenticated API envelopes, exception mapping and no-store middleware. Personal routes derive the owner from authentication; they never accept an owner ID. Support routes require the current workspace and enforce current business access.

## Personal resumes

- GET /api/v1/me/resumes: metadata only, at most 20 entries.
- GET /api/v1/me/resumes/{id}?number=N: one saved version plus history headers; organization evidence is revalidated.
- GET /api/v1/me/resumes/options: current plan template cap, AI availability/credit cost and checkout availability/price/tax.
- GET /api/v1/me/resumes/evidence: current permitted, completed, independently accepted outcomes assigned to the owner.
- POST /api/v1/me/resumes and PUT /api/v1/me/resumes/{id}: title, structured content, expectedVersion, selected evidenceIds; create an immutable unapproved version.
- POST /api/v1/me/resumes/import: bounded multipart PDF/DOCX; original remains private and separate from organization sources.
- POST /api/v1/me/resumes/{id}/improve: operationId, targetRole, expectedVersion; shared AI admission and credits; returns an unapproved suggestion.
- POST /api/v1/me/resumes/{id}/versions/{number}/approve: exact version and live source checks.
- GET /api/v1/me/resumes/{id}/versions/{number}/export?template=N&format=pdf|docx: approved branded export; direct clean=true is rejected.
- GET or DELETE /api/v1/me/resumes/{id}/versions/{number}/original: owner-only original retrieval/deletion.
- DELETE /api/v1/me/resumes/{id}: remove all text versions and private files; retain minimal purchase accounting references.

## Certifications and cash exports

- GET/POST /api/v1/me/certifications and PUT/DELETE /api/v1/me/certifications/{id}: owner CRUD, optimistic version, safe HTTPS verification links, explicit badge sharing and expiry preferences.
- POST /api/v1/me/certifications/{id}/attachment?version=N: PDF/PNG/JPEG up to 2 MB; GET downloads; DELETE with version removes. Storage keys are excluded from responses and badge projections.
- GET/POST /api/v1/me/resume-purchases: owner purchase history or preparation for one approved version/template/format.
- POST /api/v1/me/resume-purchases/{id}/verify: paymentId/signature; server-bound order and captured amount/currency checks.
- POST /api/v1/me/resume-purchases/{id}/recover: query trusted gateway status before another payment attempt.
- GET /api/v1/me/resume-purchases/{id}/download: current refund/source checks and identical stored artifact; no further charge.

Checkout defaults disabled. A missing reviewed tax configuration is not interpreted as tax exemption. Unknown gateway outcomes do not create replacement orders.

## Support and workflows

- GET/POST /api/v1/support/tickets: authorized queue (25 per page) or creation using an existing work type.
- GET /api/v1/support/tickets/{id}: current work, safe related IDs and last 50 permitted interactions.
- GET /api/v1/support/tickets/{id}/messages?version=N&offset=N: latest-first pages of 50 visible entries, returned chronologically within the page. nextOffset is null at the end. Hidden notes are filtered before paging. Changes invalidate the version (409); reload the ticket.
- GET /api/v1/support/tickets/summary: requires ReportsView and Work access; exact SQL aggregates for visible backlog, unassigned work, handoffs, open breaches and recorded response/resolution outcomes. Cancelled work is excluded from outcomes and open clocks; pre-deadline resolution pauses are respected.
- PUT .../{id}/metadata: versioned bounded category/region/language/team/custom fields.
- POST .../{id}/messages: body, visibility, stable requestKey; only staff can write private notes.
- POST .../{id}/state: version, state, reason, relatedTicketId; close requires accepted completed resolution; merges preserve original history.
- GET/POST /api/v1/support/workflows and PUT .../{id}: draft graphs; maximum 40 reachable nodes, acyclic paths and bounded waits.
- POST .../{id}/publish: version and optional restoreRevision; immutable publication/rollback.
- POST .../{id}/disable?version=N: stop future steps of this publication.
- POST .../{id}/runs: ticketId and requestKey; manual runs use the current requester.
- GET .../runs?ticketId=ID or .../runs/{id}: authorized execution status, receipts and exact pending action preview.
- POST .../runs/{id}/decide: version/accepted; stale ticket or publication requires fresh review.
- POST .../runs/{id}/cancel?version=N and .../retry?version=N: fenced cancellation or a permitted failed-step retry.
- POST .../{id}/schedules?ticketId=ID&intervalMinutes=N, GET .../schedules?ticketId=ID, DELETE .../schedules/{id}: ticket-scoped recurrence.

Automatic triggers currently cover ticket creation, public replies, ticket state changes, SLA breach and saved schedules. Arbitrary scripts, external sends and provider writes are not node types.
Support ticket customFields are a staff-only string map (up to 20 entries, non-empty keys up to 80 characters and values up to 1,000). Requesters receive an empty map and no handoff reason. PUT metadata requires the current ticket version; stale edits return conflict.
## Reviewed support routing
- GET /api/v1/support/tickets/{id}/routing: staff plus WorkEdit; authorized workload scope, top ten deterministic candidates, recorded lead/manager contacts, exact ticket/work versions. Guests, inactive users and nonpositive configured capacity are excluded. Support-team and project relationships constrain candidates; unknown capacity is explicit.
- POST .../{id}/routing/assign: ticketVersion, workVersion, assigneeId, confirmed=true. Rebuild eligibility, reject changed versions or missing candidates, lock the ticket and reuse existing work assignment/audit/notification behavior in one owned transaction. No AI credits are consumed.
- The existing Everyone workload view caps its pool at 1,000 members; the preview exposes scopeMayBeTruncated rather than claiming a full organization ranking.
- Workflow studio includes a two-stage SLA escalation draft. Recipients and wait are explicitly chosen. Each stage checks resolved/closed/cancelled/merged states, and requires its own fresh approval. A draft does not activate until saved and published under existing automation entitlements.
