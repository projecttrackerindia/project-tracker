# Agent capacity for 100 users — 10 October 2026

This review starts from `ec39c2a`. It distinguishes 100 concurrent application users from 100 simultaneous model generations. The latter is not certified on the existing CPU deployment.

## Tests and observed results

The integration regression seeds 100 separate fixture users, sessions and organization memberships, then sends synchronized HTTP agent requests through real authentication, authorization, business queries, SSE and persistence. It verifies every answer belongs to its own user, has no proposed action, costs zero credits and makes no model calls. Fixture setup bypasses registration/billing; the requests do not bypass authentication. SQLite and PostgreSQL CI run the same regression. CPU and memory below belong to the entire in-process test host, not a Railway container.

| One 100-user burst | Before | After lean project read |
| --- | --- | --- |
| Greeting successes | 100/100 | 100/100 |
| Greeting p50 / p95 | 1.391 / 1.850 s | 1.022 / 1.636 s |
| Project-status successes | 100/100 | 100/100 |
| Project-status p50 / p95 | 1.109 / 2.293 s | 0.913 / 2.347 s |
| Project-status mean database commands | 19 | 11 |
| Project-status burst CPU time | 3.672 s | 2.828 s |
| Project-status sampled host memory peak | 249.8 MiB | 263.2 MiB |

Database work fell by eight commands per request (42%). This single comparison does not establish a p95 improvement: status p95 was slightly higher. Host scheduling, SQLite writes and other load affect timing. There is no claim that all agent questions finish in these times.

A bounded production GET ramp used one supplied API credential and fresh HTTP/TLS connections. It reads the first project page and never submits model requests or business changes. All 185 requests succeeded: 10, 25, 50 and 100 simultaneous requests; respective client p95 values were 7.859, 3.641, 3.641 and 4.297 seconds. This measures concurrent requests, not 100 production identities. The harness stops on any error/rate limit and does not bypass limits or retry. It records only status/error/timing aggregates. A 60-second Railway sample around this period saw API memory peak 0.427 GB; sampling cannot establish the short burst's exact peak CPU or RAM. Ollama was idle/unloaded (~0.110 GB), so these reads did not exercise model capacity.

The isolated inference-gate burst holds one request active and submits 99 others: four wait, 95 return controlled `AI_BUSY`, and all queued requests drain with no leaked capacity. This verifies overload handling, not successful execution of 100 model requests.

Earlier actual-model tests on the installed Qwen 2.5 7B Q4_K_M measured 16–19 generated tokens/second, nine warm synthetic requests averaging 2.44 seconds, and a cold request taking 62.8 seconds with 60.8 seconds reported as model loading. Those short provider cases are not full application workflows. Twenty selection cases across two thread settings scored 8/10 each; no alternative model was downloaded.

## Implemented optimizations and user feedback

- ProjectService supplies an authorized status summary and the same task-derived progress, without loading members, owners, stages and workflow-detail lists. Tests preserve 50% progress and deny cross-workspace reads.
- Unlimited-credit preparation avoids an unnecessary monthly credit aggregate. Limited-credit checks and usage reporting remain in place.
- More anchored project-status phrases bypass inference: “Show the status of project …”, “What's the status of project …”, and “Status of project …”. Compound and attachment requests retain orchestration.
- Local streams report actual queued/running admission state. The chat explains the bounded wait and retains Stop. Cancellation tests cover disposal while queued, disposal as a slot becomes available and disposal just after admission; no HTTP inference call or slot leak follows.
- Agent Tracker exposes active/maximum inference slots, queue depth/capacity and wait limits per API instance. It does not present organization-user count as model capacity.
- Unsupported attachments and oversized context fail validation before occupying an inference slot. Existing authorization, confirmation and bounded admission are preserved.

No model concurrency, queue size, resources, paid provider or warm-residency configuration was changed. Increasing a queue alone would turn rejections into long waits.

## Capacity recommendation

Treat predictable acknowledgement, factual lookups within a few seconds, visible bounded waiting and preserved action state as the initial experience goal. A 100-user mixed-workload soak in the deployed region, with distinct controlled accounts and representative prompts, is still required before asserting a production p95 target. A successful model-free burst is not evidence for 100 simultaneous reasoning requests.

For a **Pro pilot**, start with the following allocation candidates, then measure under the intended workload. These are planning estimates, not verified production requirements or approved changes:

| Service | Starting allocation candidate | Reason |
| --- | --- | --- |
| API | 2 vCPU / 2 GB RAM | Tested API process used about 0.26 GB locally; sampled live API used about 0.43 GB. Leave room for larger tenants, requests and runtime overhead. |
| Ollama | 8 vCPU / 16 GB RAM, one model slot initially | Existing model memory previously peaked at 7.72 GB under an 8 GB cap. More memory provides headroom; it does not multiply CPU generation throughput. |
| Model volume | At least 10 GB for the current tag and operational headroom | Current filesystem is 98% full. Do not download another model before storage is expanded and cost approved. |
| PostgreSQL / Redis / frontend | Keep current allocations for the first pilot; inspect their own metrics | These tests do not establish new database/cache limits or justify changing every service. |

If 100 users must all receive reasoning answers promptly, run the next model benchmark on a larger/accelerated inference deployment. A 24-vCPU/24-GB Pro replica is a candidate to test, not a guarantee. Test parallelism 1, 2 and 4 against the same reviewed accuracy set and representative prompts; align API admission with verified provider capacity. Multi-API replicas require a shared or provider-enforced model capacity limit. Every inference worker needs model storage/loading accounted for; do not assume multiplying API replicas multiplies the existing model's throughput.

[Railway's current pricing](https://railway.com/pricing) lists Pro at $20 minimum monthly usage, with up to 24 vCPU / 24 GB per replica and usage beyond included credits billed separately. [Container resource rates](https://docs.railway.com/pricing/plans) are $20 per continuously utilized vCPU-month, $10 per GB-month of memory usage and $0.15 per GB-month of volume storage. For illustration, averaging 8 busy vCPU and 16 GB held for a full month would be about $320 compute usage, before other services/storage/egress; a configured cap is not the same as average billed use. Pro's $20 is not the price of a 100-user inference service.

The cold-load result is a material experience risk. Keeping the model resident (`Ai__Fallback__KeepAlive=-1`) is a proposed option after RAM headroom is available and the user approves the increased continuous memory cost. Prewarming must load only an already installed tag, never download during API startup. It was not applied here.

## Why CPU/RAM cannot be promised from user count

For illustration, 100 answers generating 128 tokens each within 30 seconds require at least 427 aggregate output tokens/second, before prompt processing, tools and additional model turns. The earlier single CPU runner produced about 16–19 tokens/second on short cases. More RAM addresses allocation, not this throughput gap; CPU scaling is not assumed linear.

[Ollama documents](https://docs.ollama.com/faq) that parallel requests multiply context memory. Using the [Qwen model configuration](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/raw/main/config.json), an illustrative unquantized 16-bit KV cache at 8192 tokens is `28 layers × 2 K/V × 4 KV heads × 128 dimensions × 2 bytes × 8192`, about 0.47 GB per full-context slot. One hundred slots would need about 47 GB for KV alone, plus approximately 4.7 GB of model weights and runtime buffers. This is an architectural estimate, not measured Ollama peak allocation. Quantized cache/context changes require accuracy testing. A single 24-GB replica is not a validated solution for that configuration.

Before paying for a large CPU fleet, compare the installed model on larger hardware with an appropriately sized accelerated worker and a smaller model on the same accuracy/workload dataset. This work does not authorize a new paid provider or resource purchase. Do not present an infrastructure upgrade as proof of 100-user AI acceptance.

## Validation and rollback

Local focused backend validation passed 15 tests for the initial optimization, then 41 tests including streaming compatibility, queue-cancellation races and deterministic phrasing. Frontend: 70 tests, typecheck/build passed; lint zero errors and 75 existing warnings. The associated PR records full CI, deployment revision and post-deployment checks.

No migrations or infrastructure changes. Roll back API/frontend to `ec39c2a`, or revert the associated merge commit. Preserve pending actions and delivery receipts. Never automatically replay mutations to recover from a busy response.
