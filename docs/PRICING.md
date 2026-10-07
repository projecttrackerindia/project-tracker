# Pricing and the arithmetic behind it

Paid plans are priced **per person per month**, in the platform's billing currency (INR by default, excluding GST). Storage and AI credits are per person and **pooled** across the workspace. The numbers below are the built-in catalog (`DatabaseInitializer.PlanCatalog`, catalog version 2); a platform administrator can change any of them under Admin → Plans.

## The plans

| | Free | Pro | Business | Enterprise |
|---|---|---|---|---|
| Price | ₹0 | **₹349** per person / month | **₹699** per person / month | custom |
| People | 1 | pay per person | pay per person | by contract |
| Files | 500 MB | 5 GB per person | 25 GB per person | unlimited |
| AI model levels | Quick | Quick, Standard | Quick, Standard, Deep | all |
| AI credits / month | 10 | **60** per person | **200** per person | 25,000 shared (override per organization) |
| AI reads files / takes actions | – / – | yes / – | yes / yes | yes / yes |
| Documents (`DOCUMENT_LIMIT`) | **10** | unlimited | unlimited | unlimited |

**Discounts** (`Billing:Pricing`): paying a year at once takes **20% off**; teams of 10+ get **10%**, 25+ **15%**, 100+ **20%** automatically. They add up to at most **30%**. A discounted total is rounded to a whole rupee. **Trial:** 14 days of Pro or Business, up to 5 people and 100 AI credits, no payment.

Examples: 12 people on Pro, monthly: 349 × 12 − 10% = **₹3,769**. The same, yearly: 349 × 12 × 12 − 30% = **₹35,179** a year (₹244.30 per person per month). 100 people on Business, yearly: 40% would apply, capped at 30%.

**Documents** cost almost nothing to run (rows of text; their files count against the storage pool people already pay for), so the only limit in the first release is how many a Free workspace may hold (10). Deleted documents do not count and can be restored for 30 days. Later releases add the governance features by plan as set out in `docs/proposals/documentation-platform.md` section 12 (approval workflows, expiring grants, secret reveal, audit export, PDF exports per month, history retention that follows `ACTIVITY_RETENTION_DAYS`). **Release D3** applies it to review: no workflow on Free (the owner publishes), one default multi-step workflow on Pro (`CUSTOM_WORKFLOWS`), a workflow per kind of document with due times and reminders on Business (`ADVANCED_PERMISSIONS`); asking for access, requirement coverage and the document's activity are on every plan, the full audit trail with export needs `AUDIT_LOG` (Business). **Release D4** adds `DOC_ENDPOINT_LIMIT`, the documented API endpoints a workspace may keep (Free 50, Pro 2,000, Business 25,000, Enterprise unlimited unless the contract says otherwise); describing APIs, importing and exporting OpenAPI and Postman files and the API-changes check are on every plan, only the number of endpoints differs. A workspace that moves to a lower plan keeps every endpoint but cannot add or import more while it is over the limit. **Release D5** (secrets): keeping secrets, masked everywhere, and revealing them with the `docs.secrets.reveal` permission (owners, admins and managers by default) are on every plan; on Business and above: the reveal time chosen by an administrator (10/15/30/60 s or 5-300), the *Confidential* class that needs a fresh two-step check, data-key rotation and the audit-trail verification (`ADVANCED_SECURITY`). A workspace that moves down keeps its secrets and the chosen time, but cannot add confidential ones or rotate. A workspace that moves down keeps its workflows but only the ones its plan allows apply. A workspace that moves to a lower plan keeps every document; it just cannot create more while it is over the limit. **Release D2** applies the plan to history and sharing: old versions are removed after the plan's history period (`ACTIVITY_RETENTION_DAYS`: Free 30 days, Pro 1 year, Business 2 years, Enterprise unlimited; a workspace's own data policy can shorten it), except the newest published version and the newest three of each document; blocking a person, team or role and ending access on a date need `ADVANCED_PERMISSIONS` (Business and above); files count against the workspace's storage pool and the plan's file-size limit.

## What an AI credit costs us

A credit is a unit of AI use: a Quick answer is **1** credit, Standard **4**, Deep **20** (`Ai:Chat:*:Credits`). Provider prices (US dollars per million tokens, `Ai:Chat:*:InputPerMTok/OutputPerMTok`): Haiku 4.5 1 / 5, Sonnet 5.5 2 / 10, Opus 5.5 4 / 20; cached input costs a tenth (a twentieth on Opus). At ₹88 to the dollar, an answer that chains about three model calls, with 60% of its input served from the cache, costs roughly:

| Level | Tokens in / out | Cost | Credits | Cost per credit |
|---|---|---|---|---|
| Quick | 18,000 / 750 | ₹1.06 | 1 | ₹1.06 |
| Standard | 24,000 / 3,100 (with low-effort reasoning) | ₹4.67 | 4 | ₹1.17 |
| Deep | 30,000 / 12,000 (with high-effort reasoning) | ₹25.66 | 20 | ₹1.28 |

Deep used to be 15 credits (₹1.71 per credit); at 20 every credit costs about the same whichever level answers. With a mix of 50% Quick, 40% Standard and 10% Deep answers, a credit costs **about ₹1.2**. These are estimates: **Admin → AI usage** records the real tokens and shows an estimated provider cost per organization. Check it after the first weeks of real use and change the credits per level, or the credits per plan, if it differs.

## Margin per person

Cost lines: payment fee 2.36% (Razorpay 2% plus 18% GST on the fee), servers/database/e-mail/push ₹18 (Pro) or ₹22 (Business), storage ₹2 per GB-month, AI at ₹1.2 per credit. "Typical" assumes 35% of the credits and 40% of the storage are used; "worst" assumes all of both are.

| | Price per person / month | Typical contribution | Worst case |
|---|---|---|---|
| Pro, monthly | ₹349 | ₹293 (84%) | ₹240 (69%) |
| Pro, yearly | ₹279 | ₹225 (81%) | ₹172 (62%) |
| Pro, 25 people, yearly (−30%) | ₹244 | ₹191 (78%) | ₹138 (56%) |
| Business, monthly | ₹699 | ₹556 (80%) | ₹368 (53%) |
| Business, yearly | ₹559 | ₹419 (75%) | ₹232 (41%) |
| Business, 100 people, yearly (−30%) | ₹489 | ₹351 (72%) | ₹164 (33%) |

Every case stays positive even when each person uses every credit and every gigabyte. The only open-ended cost was "unlimited" AI, so no plan has it any more: Enterprise gets a large shared pool, and a contract can override it per organization (Admin → Organizations → feature exceptions). A **free** account costs at most ₹10 a month in AI (10 Quick answers); a **trial** at most about ₹135.

## How seats work in the product

- A workspace has **seats** (`Subscription.Seats`): the most people it can have, counting members and open invitations. Storage and AI credits are the per-person values times the seats. Inviting beyond the seats is refused with "Add seats in Settings → Billing".
- Nobody can pay for fewer seats than there are people. Plan, seats and monthly/yearly are chosen in Settings → Billing; the price is quoted live (`GET /billing/quote`) and charged by the server from the same arithmetic (`Pricing.Quote`).
- **With Razorpay**, each choice creates a Razorpay plan for the whole amount of the cycle (people × price, less discounts; monthly or yearly) and a subscription on it. Adding or removing people on the plan and period already paid for creates the new subscription to **start at the next renewal**: new seats work at once, the old subscription is set to end with the current cycle, and nothing is charged twice. Fewer seats take effect at the renewal. Changing plan or switching between monthly and yearly starts a new cycle immediately (the old subscription ends at once).
- **Simulated payments** (no provider configured) charge the same amounts immediately.
- **Existing databases** are moved to catalog version 2 once at start-up: new prices and limits, and every paying workspace keeps its people as seats (at least 5), so nobody is locked out the day prices change. A Razorpay subscription made before keeps charging its old amount until the owner chooses seats again.

## Changing the numbers

Prices and per-person limits: Admin → Plans (tick "Priced per person" for a per-person plan). Discounts and the seat cap: `Billing:Pricing` (`AnnualDiscountPercent`, `VolumeTiers`, `MaxTotalDiscountPercent`, `MaxSeats`). Credits per level: `Ai:Chat:Quick|Standard|Deep:Credits`. The public website shows the live prices and discount rules from `GET /api/v1/public/pricing`; its printed defaults are in `frontend/site/content.ts`.
