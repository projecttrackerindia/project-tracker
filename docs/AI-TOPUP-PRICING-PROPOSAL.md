# Orbit AI top-up pricing proposal

Draft for business review, October 10, 2026. Purchases remain disabled. These are organization-shared credit packs, not individual subscriptions or guaranteed model-token quantities. Existing plan grants and per-answer charges stay unchanged.

| Pack | Credits | Price before applicable taxes | INR/credit | Maximum fully allocated cost/credit at 20% margin* |
| --- | ---: | ---: | ---: | ---: |
| Starter | 100 | 149 | 1.490 | 1.1473 |
| Growth | 500 | 699 | 1.398 | 1.0765 |
| Scale | 1,000 | 1,299 | 1.299 | 1.0002 |

*Assumes payment processing, including unrecoverable tax on the fee, totals 3% of pretax revenue. This is a planning assumption, not a verified gateway quote. If the fee is applied to the tax-inclusive payment amount, use its higher effective percentage against pretax revenue instead. Verify actual gateway pricing and tax treatment before publishing packs.

Recommend 90-day validity from verified payment, displayed before checkout and in the receipt. Consume monthly included credits first, then purchased lots in expiry order. Monthly plan credits reset on the first UTC day; purchased lots must survive that reset. Refunds, chargebacks, expiry and adjustments require separate append-only ledger entries and immutable lot allocations. Credits belong to the purchasing organization and are subject to existing person/team budgets and request caps. Top-ups must not unlock a model tier or feature excluded by its subscription. These rules are proposed, not implemented purchase behavior.

## Profit calculation

Use margin on sales, not markup on costs:

`margin = (pretax price - effective payment fees - all allocated costs) / pretax price`

For pack credits `N`, full cost/credit `C`, effective fee fraction `f`, and target margin `m`:

`minimum pretax price = N * C / (1 - f - m)`

At `C = INR 1.00`, `f = 0.03`, `m = 0.20`, 1,000 credits need at least INR 1,298.70. INR 1,299 gives about 20.02%; INR 699/500 gives 25.47%; INR 149/100 gives 29.89%. At `C = INR 1.20`, the INR 1,299 pack earns only about 4.62%, so it must be repriced or withheld. A 20% markup would give a smaller margin and is insufficient.

Full cost must include model calls (including thinking, tools, classifiers, retries and failed/uncharged requests), actual USD/INR settlement rate and currency fees, applicable unrecoverable provider taxes, allocated Railway/database/Redis/storage costs, support, refunds and fraud, and a risk reserve. Include engineering and other fixed expenses when claiming net business profit. Until those allocations are measured, the figures above are contribution-margin targets, not a promise of net profit.

Google's published standard Gemini 3.5 Flash-Lite rates are USD 0.30/M input, 2.50/M output including thinking, and 0.03/M cached input; caching storage and paid grounding have additional charges. Source: https://ai.google.dev/gemini-api/docs/pricing (checked October 10, 2026).

Illustrative provider-only calculation using a deliberately assumed INR 100/USD planning exchange rate (not a current exchange-rate quote):

| Entire answer, summed across all model turns | Uncached input tokens | Output incl. thinking | Estimated provider INR |
| --- | ---: | ---: | ---: |
| Short answer | 4,000 | 400 | 0.22 |
| Ordinary evidence-based answer | 12,000 | 1,500 | 0.735 |
| Long tool-heavy answer | 80,000 | 8,000 | 4.40 |

These are cost scenarios, not measurements. Ordinary answers already leave little room below the Scale pack's INR 1 cost threshold once taxes, hosting, failures and support are allocated. The current fixed Quick/Standard/Deep charges (normally 1/4/20) cannot guarantee this threshold: Quick may still perform multiple tool rounds. A different provider or future model price changes the calculation.

## Launch gate

1. Measure representative, consented production usage by tenant, tier and feature using recorded price snapshots and provider invoices; no bulk AI testing is required. Count unpriced and failed calls conservatively instead of treating them as zero. Reconcile the pilot admission budget separately from the actual prepaid account balance.
2. Establish bounded cost per purchased credit. Choose an explicit commercial policy: quote/reserve a worst-case token/tool budget and stop before exceeding it, or show an upfront maximum credit quote and settle actual cost-based credits with a tier floor. This changes current billing promises and needs a published policy; do not silently reprice existing answers.
3. Maintain at least 20% target margin using the largest pack's lowest unit price and stressed costs, with a monthly review and a price version recorded on each order. Do not depend on customers leaving credits unused to fund operations.
4. Implement purchased lots, an order catalog, server-created orders, verified signed payment reconciliation, idempotent fulfillment, refunds/chargebacks and expiry before enabling checkout. A browser success callback or payment-reference field cannot mint credits.
5. Publish prices, taxes, expiry, refund policy and usage definitions. Only then enable sales. A top-up does not purchase provider concurrency or eliminate platform safety/permission limits.
