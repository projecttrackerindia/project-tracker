# Seeded browser smoke refresh

The advisory smoke job on release 79bbbc5f failed against retired UI: dashboard charts, a team lens in the top bar, the capsule/FAB phone shell and the old Documents toolbar. Pricing asserted a hard-coded 349 instead of the live price list. This update follows the current Home, Aura Create, phone bar and Library reader.

The journeys run against a real local Development API and seeded accounts. They are not production tests. The shared helper rejects external hosts because the tests create documents, reviews, permissions and synthetic secrets, change mock billing, and rotate the disposable document key. No real provider credentials or external messages are used.

| Journey | Current coverage |
| --- | --- |
| Main shell | Home/team selection, main places, overflow, Aura Create project, account menu |
| Mobile | Five-place bar, active route, More, Create, field sizes, overflow, pull-to-refresh, resize |
| Public | Existing metadata/navigation checks retained; Pro price compared with `/public/pricing` |
| Documents | Current template wizard and reader, editor save/reload, publish, version compare/restore, sharing, file persistence and project backlink |
| API reference | Import preview without writes, apply, required parameters, export, breaking removal, credential redaction and endpoint reader |
| Review | Cross-user approval, denial of self-approval, publish history, requirement coverage, activity and private access requests |
| Secrets | Masked list, reveal/hide, timed re-mask, confidential step-up denial, audit, rotation preserving values and audit-chain check |
| PDF | Diagram on screen, downloaded PDF bytes/contents/page numbers/diagram, full-text search and overview counts |
| Invitations | Existing registration, fresh-context verification, sign-in and workspace acceptance journey retained |

Persisted business outcomes are asserted through the live API; navigation, wizard, editor, selected reader/inspector states and PDF download are asserted through the browser. Layout checks tied to the removed dashboard/capsule and old toolbar were replaced with current-screen assertions. This does not claim identical visual coverage of every retired control. Synthetic UI checks in required CI remain complementary coverage.

The smoke workflow runs on PR changes to these files, retains diagnostics, and no longer hides job failure with `continue-on-error`. Results and remaining failures belong in the PR validation record; this document does not claim a passing run in advance.
