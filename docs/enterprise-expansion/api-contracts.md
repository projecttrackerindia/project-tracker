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

## Google connection safety
Google connect still returns {url}, and now sets a Secure, HttpOnly, SameSite=Lax ten-minute browser-proof cookie scoped to its callback. Callback requires both this cookie and an unexpired, unconsumed state; only one concurrent callback can redeem an attempt. The current active workspace membership is rechecked before token exchange and before connection persistence. Google status includes calendarAccess; partial grants cannot be used for Calendar writes. Reconnect updates the existing tenant/user connection.

## Personal email
All routes below require the authenticated owner in the active workspace; another member, administrator or tenant receives 404 for a draft ID.
- GET /api/v1/me/email-drafts/options: AI availability, centrally configured Quick credit cost and 6,000-character AI input bound.
- GET /api/v1/me/email-drafts: at most 100 metadata summaries; body is omitted as an empty string. GET /{id} retrieves one saved message.
- POST /api/v1/me/email-drafts and PUT /{id}: recipient, subject, body, optional provider (google or microsoft, default google); updates require the exact version. One bare recipient only, subject 1-200 characters without controls, body 1-20,000 characters.
- POST /{id}/improve: operationId, version, style (concise/formal/friendly), confirmed=true. Reserves shared credits, validates the response, atomically saves an unsent draft and settles credits. Invalid results release the reservation; replay does not invoke the model again.
- POST /{id}/send: exact version, confirmed=true, senderEmail matching the connected identity. Requires the saved provider deployment gate and delegated send permission. Returns provider, confirmedSenderEmail and accepted/unknown status. Gmail acceptance includes providerMessageId; Microsoft acceptance has no message ID and may include providerRequestId. Acceptance does not prove recipient delivery.
- DELETE /{id}: removes an unsent draft or erases accepted message content. Sending/unknown receipts cannot be removed through this endpoint.
- GET /api/v1/integrations/google/connect?mail=true requests optional send-only consent plus sender identity. Existing calendar-only connection requests do not request mail permission. Provider cumulative grants are reported separately.
## Microsoft connection
- GET /api/v1/integrations/microsoft/status: enabled, configured, connected, email and mailSendAccess for this user/workspace; no tokens.
- GET .../connect: enabled/configured gate, browser-bound ten-minute OAuth URL with PKCE S256 and a Secure/HttpOnly callback cookie.
- GET .../callback: anonymous provider return; hashed state plus matching browser proof, expiry, atomic consumption and current membership are mandatory.
- POST .../disconnect: erase this user's local connection and audit metadata; no claim of remote consent revocation.
- Private email metadata/detail include provider, optional providerRequestId and confirmedSenderEmail. Legacy receipts keep sender null rather than infer a historical identity from the current connection.

## Private calendar proposals
Authenticated user and active workspace ownership apply to every route; another member/administrator/workspace receives 404 for private proposal IDs. Responses are not cached.
- GET /api/v1/me/calendar-proposals/options: enabled, account and actual Calendar access; no credentials.
- GET base: at most 100 metadata summaries; notes are omitted. GET /{id}: full private proposal.
- POST base: title (1-200), description (up to 6,000), start/end with offsets, valid IANA timeZone. Start is at least one minute ahead and within a year; duration is positive and no more than 24 hours. Saved proposals are immutable; save a new proposal to change details.
- GET /{id}/availability?version=N: read-only blocking-event count for the primary connected calendar; incomplete pagination or invalid responses fail closed.
- POST /{id}/confirm: version, confirmed=true, account matching the reviewed connection. Fresh conflict/membership checks precede an atomic durable claim. At most ten confirmations per person/workspace/hour. No attendees, automatic retries or model calls.
- POST /{id}/reconcile: read-only recovery of unknown or stale sending receipts. Verifies ID, tenant/owner/proposal markers, title/notes and exact times. It cannot resend or infer success from a missing/changed event.
- DELETE /{id}: removes draft content or erases verified receipt text/account/times, preserving rate history. Sending/unknown deletion is blocked; this does not delete a provider event.

## WhatsApp inbound foundation
Organization owner/admin routes, all under /api/v1/integrations/whatsapp:
- GET /status returns configuration, reception, eligibility and connection metadata. installationEnabled reflects its configuration and default-off gate; messagingEnabled remains false.
- GET /receipts requires active subscription plus WHATSAPP_INTEGRATION, returning up to 50 current-tenant metadata entries. Outcome is identity_verification_required; no sender identity, message ID, message content or token is returned.
- POST /disconnect disables reception for this mapping and erases local usable credentials. This does not revoke a Meta grant and does not remove the reserved mapping.

Anonymous provider routes:
- GET /webhook accepts hub.mode=subscribe, exact hub.verify_token and a bounded numeric hub.challenge; returns the plain-text challenge.
- POST /webhook requires X-Hub-Signature-256 over the exact raw bytes. Payload limit is 64 KiB, JSON depth 20, at most 20 entries, 20 changes per entry and 100 messages across the envelope. Entire envelopes validate before writes. Inactive, unmatched and ineligible connections are acknowledged without receipts.
- Reception defaults off and returns 503 WHATSAPP_RECEPTION_DISABLED. Invalid verification/signatures return 401. Invalid/oversized envelopes return 422 at the application layer; host/proxy body limits may reject earlier.
Connect/complete/cancel are described below. At the receiver foundation checkpoint, no send, reply, contact-link, ticket-mutation or AI-processing route existed; the subsequent contact routes are described below.

## WhatsApp Embedded Signup installation
Authenticated organization owner/admin routes under /api/v1/integrations/whatsapp:
- POST /connect: requires an active entitled subscription, complete configuration and InstallationEnabled. Returns state, appId, configId, apiVersion and signupVersion. Sets a ten-minute Secure, HttpOnly, SameSite=Strict browser-proof cookie scoped to these routes; proof is never returned in JSON. At most five pending attempts per organization.
- POST /complete: body {state, code, businessAccountId, phoneNumberId}; maximum 8 KiB. Requires the same authenticated user, organization, browser and configuration. Consumes state before code exchange, then verifies provider assets and rechecks permission, entitlement and disconnect fencing before saving. Returns 204 and clears proof cookie. Tokens remain backend-only.
- POST /cancel: body {state}; consumes a matching unconsumed attempt and clears proof cookie.
Installation and webhook reception have separate default-off gates. messagingEnabled remains false. A conflicting reserved phone mapping cannot be transferred to another organization; original-owner reconnection requires the same app/business/phone mapping. Configuration rotation invalidates unfinished attempts.

## Self-service WhatsApp contact proof
Routes under /api/v1/me/whatsapp-contact are authenticated, workspace-scoped and no-store. They operate on the current user only; organization administrators cannot enumerate or edit another member's contact link.
- GET: returns enabled, eligible, businessName, status (unavailable/unlinked/pending/verified), maskedPhone, expiresAt, verifiedAt, consentVersion and outboundEnabled=false. Personal workspaces return unavailable without an error panel. Stale configuration, changed connection epoch, expired pending code or thirty-day verification age clears stored linkage.
- POST: {phone, acknowledged:true}, maximum 1 KiB. Requires active organization membership, entitled active subscription, active unexpired app-matching installation and both contact/reception gates. Supported input is + followed by 8-15 ASCII digits without a leading zero. Returns the exact PT-LINK message and ten-minute expiry; replaces an earlier link. At most five preparations per user/organization/hour.
- DELETE: clears the current user's phone, proof and account-link consent, preserving rate history.

The existing signed webhook recognizes only an exact challenge from the entered number, routed through the registered app/business/phone mapping. It rechecks membership, active user, installation epoch, configuration, fresh provider timestamp and unexpired challenge inside the tenant transaction. A wrong sender/tenant, arbitrary text or duplicate provider message cannot grant access. General messages remain metadata-only; proof handling does not invoke AI or mutate tasks. The receipt-storage cap does not prevent an otherwise valid proof. At the contact-proof checkpoint, outbound consent and business actions were unavailable; the separate notification-consent routes are described below. Business-action execution remains disabled.

## Private WhatsApp notification preferences
Authenticated, current-user-only, workspace-scoped, no-store routes under /api/v1/me/whatsapp-contact:
- GET /notification-preferences: version, optedIn, canEnable, taskAssignments, overdue, supportUpdates, timeZone, quietStartMinutes, quietEndMinutes, requiredConsentVersion, consentAt, expiresAt, deliveryEnabled=false. An organization administrator cannot select another member. Personal workspaces return disabled defaults.
- PUT /notification-preferences: {version, optIn, acceptedConsentVersion, taskAssignments, overdue, supportUpdates, timeZone, quietStartMinutes, quietEndMinutes}; maximum 2 KiB. Grant requires current verified phone, installation epoch/configuration, active entitled subscription, contact/reception gates and explicit whatsapp-notifications-v1 acceptance. At least one closed category, an IANA time zone and distinct minute-of-day quiet-hour values (0..1439) are required. Times can cross midnight.
- A version conflict returns 409 WHATSAPP_PREFERENCES_STALE. Missing current proof/gate returns 409 WHATSAPP_CONTACT_REQUIRED; missing plan returns 403 WHATSAPP_PLAN_REQUIRED. Validation errors return 422. A successful save increments the version and does not send a message.
- optIn=false revokes the owner's notification purpose without requiring provider activation or active subscription. Current membership remains required. Unlink, replacement, disconnect, configuration/epoch change and proof expiry invalidate consent; preference updates cannot extend proof expiry.

This purpose authorizes only future selected organization notifications. It grants no marketing, voice/recording consent, project access or permission for automatic actions. The eventual dispatcher must freshly enforce recipient/project permissions, plan/gates, purpose expiry, quiet hours and provider policy before every send. No dispatcher, template/24-hour policy or provider delivery is implemented in this checkpoint.

## WhatsApp provider health
Owner/admin-only current-organization routes under /api/v1/integrations/whatsapp, no-store:
- GET /health returns checkEnabled, state, checkedAt, tokenValid, scopesPresent, assetsVerified, appSubscribed, phoneVerified, messagingEnabled=false. It performs no provider requests. States are unchecked/checking/verified/attention/unavailable/stale. A result older than five minutes, changed configuration or invalid current connection is stale; old boolean claims are hidden. A thirty-second abandoned claim becomes unavailable.
- POST /health/check requires active plan entitlement, configured installation settings and the default-off HealthChecksEnabled gate. Claims a durable per-organization lease before bounded read-only Graph requests; at most one attempt/minute. A simultaneous check returns 409 WHATSAPP_HEALTH_CHECKING; cooldown returns 429. Unconfigured/off checks return 409 WHATSAPP_HEALTH_DISABLED.
- Checks verify token/app/lifetime, required WABA-scoped management/messaging grants, current business/phone ownership and app subscription. Missing or ambiguous grants cannot establish readiness. Unsupported/oversized/paginated/error responses report unavailable; no raw provider diagnostics or credentials reach clients.
- Permission, plan, configuration, lease, connection epoch and protected-token snapshot are rechecked after network I/O. A changed connection returns 409 WHATSAPP_HEALTH_STALE; removed access returns 403. Disconnect/reconnection clears observations and claims while preserving attempt cooldown. Only a verified inspection may shorten a recorded token deadline, never extend or erase it.

Verified means these read checks passed. It does not prove phone registration, deployed webhook delivery, template approval or permission to send. This endpoint cannot subscribe an app, register a phone, send messages or enable business actions.
