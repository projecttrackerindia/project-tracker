# Module delivery order

The user selected individual module review on 12 October 2026. Every module must have a professional, futuristic UI: deliberate hierarchy, efficient use of space, coherent light/dark themes, responsive layouts, keyboard controls and restrained motion with reduced-motion support. Show actual built-app images before each batch commit. Do not sacrifice these requirements for speed. Demo screenshots must be labeled synthetic; they do not verify live integrations.

Individual review batches preserve the existing requirement to finish the expanded scope before the final main merge. The original six workstreams remain open where listed in implementation-plan.md; the ordered modules below are delivery slices of that scope. Voice remains a follow-on release.

| Order | Module | Status at this checkpoint |
| --- | --- | --- |
| 1 | UI and integration setup guides | Implemented and locally verified; final branch CI required |
| 2 | Personal inbox and email | Implemented inbox, summaries, attachments and confirmed sends; controlled provider and quality verification remains |
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
