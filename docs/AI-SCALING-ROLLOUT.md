# AI scaling rollout

## Step 1: plan-based admission and greeting routing

AI generation endpoints now share atomic limits per authenticated user AND workspace. Integrations and chat cannot create separate allowances by switching endpoints. These are operational request caps, separate from the existing monthly credit allowance.

| Effective plan | Requests/minute | Requests/hour | Requests/UTC day | Active requests per person | Existing monthly credits |
|---|---:|---:|---:|---:|---|
| Free | 5 | 30 | 100 | 1 | 10 per workspace |
| Pro | 10 | 120 | 500 | 1 | 60 per paid seat, pooled |
| Business | 20 | 300 | 1,500 | 2 | 200 per paid seat, pooled |
| Enterprise | 30 | 600 | 3,000 | 3 | 25,000 pooled by default; existing administrator override applies |

All three request windows must allow a request. No admission queue is added. Minute/hour/day windows reset on UTC clock boundaries and allow a boundary burst; they are not a provider token-rate limiter. Unknown plan codes use Free defaults. Expired subscriptions use the effective Free plan. Plan changes do not reset the counters. Seat counts do not multiply a person's request allowance.

The same caps cover `/ai/ask`, conversation follow-ups, and the legacy portfolio-summary, risk, search, triage and action-items generation endpoints. Reads, file management, action confirmation/dismissal and deterministic portfolio endpoints keep their existing API limits. Admitted requests count even if validation or generation later fails; requests rejected by admission do not increment counters. An admitted greeting counts as a request but, on the existing local route, uses no inference or AI credits.

Redis is selected automatically when `Redis:ConnectionString` is configured. One Lua script checks all windows and concurrent leases before incrementing anything. Counters are shared across API replicas; Redis failures refuse AI admission with 503 instead of permitting unbounded paid calls. Single-instance development uses atomic memory counters. Enable the following before adding API replicas:

```text
Redis__ConnectionString=<private Redis connection string in Railway secrets>
Ai__RateLimits__RequireDistributed=true
```

The Redis connection string must use the format already accepted by StackExchange.Redis, matching the existing deployment configuration. Creating a Redis service without setting this variable does not enable shared admission. Inspect `/api/v1/ai/usage` → `requestLimits.distributed` to verify it.

Per-plan settings are configurable, for example:

```text
Ai__RateLimits__Pro__PerMinute=10
Ai__RateLimits__Pro__PerHour=120
Ai__RateLimits__Pro__PerDay=500
Ai__RateLimits__Pro__Concurrent=1
```

Use `Free`, `Pro`, `Business` or `Enterprise` in the configuration path. Values must be positive. The legacy `Ai:HourlyLimit` no longer controls these endpoints. Existing plan prices, tier ceilings, attachment/action entitlements, trials and pooled monthly credits are unchanged.

The API returns HTTP 429 with a specific code (`AI_MINUTE_LIMIT`, `AI_HOUR_LIMIT`, `AI_DAY_LIMIT`, `AI_USER_CONCURRENCY_LIMIT`) and `Retry-After`. The chat preserves the rejected question and attachments and disables resubmission for that delay. Admission leases release after the complete HTTP action, including streamed answers. Expiring leases recover slots after process crashes; the lease lasts longer than the configured execution deadline plus preparation headroom. Request counters expire independently.

Compound greetings such as `hey hi` now match the existing model-free local shortcut. Requests such as `hi, show overdue tasks` do not. Local inference queue expiry now reports `AI_QUEUE_TIMEOUT`, rather than claiming that a queue is full.

These controls limit abuse and duplicate active work. They do not make the local model faster or prove readiness for 5,000 simultaneous AI questions. The workspace monthly credit check retains its existing check-then-save behavior; concurrent credit reservations and a provider spending ledger are separate work required before treating application credits as a strict financial ceiling. Legacy one-shot endpoints retain their existing credit-accounting behavior. Keep a provider-side spending cap during the pilot.

## Step 2: verify Gemini API billing before connecting production

The owner supplied a receipt for ₹500 received on October 10, 2026 and a screenshot showing accepted India tax information. The intended project is **project tracker**, `gen-lang-client-0699313292`, with **Tier 1 / Prepay** and one API key. The earlier Default Gemini Project is a different project; do not configure its key by accident.

The owner reports active interactive Flash-Lite limits of 4,000 RPM, 4 million input TPM and 150,000 RPD. These are project-wide ceilings, not verified sustained throughput. The backend Railway variable `AI_gemini_apikey` exists. A synthetic one-shot check with that secret returned HTTP 200, STOP and READY in 2,300 ms (8 input / 1 output tokens); no business data was sent. This single call does not establish latency percentiles or tool-use accuracy.

1. Open https://aistudio.google.com/billing with that account and select the intended project. Confirm available API credit and an active billing account.
2. Open https://aistudio.google.com/api-keys and check that project's paid plan/tier. A Gemini app subscription alone does not provide API billing.
3. Store the API key as a backend Railway secret. Do not paste it into chat, commit it, or expose it in the frontend.
4. Set an API-project spending cap and application budget reservation policy before a broad rollout. ₹500 is a pilot budget, not a capacity reservation for 5,000 simultaneous generations.

Sources: https://ai.google.dev/gemini-api/docs/billing and https://ai.google.dev/gemini-api/docs/rate-limits.

## Step 3: implement and verify streamed cloud tool use

The independent native Gemini adapter supports streamed text, function declarations/results, opaque response-part/signature replay, cancellation, usage including thinking tokens, response-size guards and sanitized failures. The OpenAI-compatible streamed adapter still excludes Google addresses; select Gemini through its own route rather than overwriting the Ollama fallback. A separate synthetic provider check completed two native SSE requests and a signed arithmetic-tool round in 3,213 ms, with correct arguments/result and STOP. Both requests returned HTTP 200 (274 input / 98 billed output tokens across the two turns). No business data or actions were involved; this verifies the provider contract, not application accuracy or concurrency.

`AI_gemini_apikey` maps to `Ai:Gemini:ApiKey` only when that option has not already been configured. A key alone does not activate paid traffic. Explicit pilot configuration is:

```text
Ai__PrimaryProvider=gemini
Ai__Gemini__Enabled=true
Ai__Gemini__ProjectId=gen-lang-client-0699313292
Ai__Gemini__Model=gemini-3.5-flash-lite
```

Keep these activation settings off until verification finishes. The adapter accepts extracted text only; PDF/image processing remains outside the initial pilot. Diagnostics report cloud health as unsupported instead of probing Ollama and presenting its queue as Gemini capacity. Both one-shot routing and streamed routing use the explicitly selected Gemini provider, without automatically replaying on Ollama after dispatch.

Shared Redis admission reserves each dispatched model round, including classifier/one-shot calls. Default pilot ceilings are **60 requests/minute, 120,000 estimated input tokens/minute and 100 requests/UTC day**. Input reservations use UTF-8 request bytes plus 4,096 tokens of overhead; they are conservative estimates, not a tokenizer or provider-reconciled bill. Output reservations use the configured maximum output budget (1,024 by default), including thinking. Failed/cancelled requests are not refunded. Fixed UTC admission windows are not Google's daily window or a rolling token bucket; provider 429 remains possible at boundaries or from other consumers.

Persistent project-wide pilot allowances are **2 million estimated input tokens and 100,000 reserved output tokens**, stored in `pm:gemini:{projectId}:pilot:v1`. They do not reset on application restart or at midnight, and do not expire. This intentionally pauses the pilot when allowance is consumed; review actual provider spend before increasing either allowance. Redis deletion/eviction can lose reservations: these counters are operational guardrails, not the durable financial ledger required in Step 4. Require reliable Redis and a provider spending cap. Other applications/keys on the same Google project do not share this application's counters. Gemini refuses dispatch when Redis is absent or unavailable.

Start with `gemini-3.5-flash-lite`, cloud disabled unless explicitly configured, text-only pilot first. Keep permission checks, evidence retrieval, calculations and consequential action confirmation in the backend. Select one cloud model initially; evaluate a stronger model only where accuracy evidence justifies its cost. Streaming-contract tests and real Redis admission tests are required before merging; actual provider/tool and application load tests remain separate acceptance evidence.

Use provider/project-wide request and token admission in addition to the per-user limits. Share it across replicas. Do not multiply local Ollama parallelism or provider allowances by adding API servers. Do not restart an answer on another provider after partial output or a possible side effect.

## Step 4: durable document jobs and cost controls

Use PostgreSQL-backed jobs with idempotent job IDs, worker leases, progress, cancellation and saved results. Start with one background worker and isolate document generation from interactive traffic. Reserve estimated worst-case provider cost before dispatch, reconcile actual usage, and enforce workspace and platform budgets atomically. Keep request caps separate from credits and currency spending limits. Apply organization fairness so one tenant's burst cannot monopolize capacity.

## Step 5: expand only from measured demand

Test 100, 500, 1,000 and 5,000 simulated users with a defined AI request frequency and realistic prompts. Separately test simultaneous-generation bursts against the purchased provider quota. Record queue time, first-token time, completed-answer p95, timeouts/429s, token cost, database connections, API CPU/memory, permission isolation and duplicate actions. Require actual answered requests in acceptance reports; HTTP 200 alone is insufficient for SSE.

Add API replicas, worker capacity and database resources only where those measurements justify them. A dedicated GPU is a later cost comparison, using measured sustained token demand and maintenance costs. No paid resources, model changes or provider data transfers were performed as part of Step 1.
