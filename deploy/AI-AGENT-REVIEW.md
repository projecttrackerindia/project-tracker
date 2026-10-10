# AI agent reliability review — 10 October 2026

Baseline: `main` at `bb84ea21d3b5c27cb0487d4e09c316bff53b8f05`. This review addresses the supplied scalability/reliability brief with the existing React, .NET, PostgreSQL/SQLite and local-model architecture.

## Evidence and fixes

| Finding | Evidence on baseline | Result |
| --- | --- | --- |
| Project names did not normalize spacing or tolerate typos | Three rename cases returned no proposal for an existing project | Shared conservative name matching handles normalization, one edit and adjacent transposition for names of at least six normalized characters. Multiple matches require clarification. IDs and emails are never typo guessed. |
| Project resolution considered only the first 500 records | `ProjectAsync` applied `Take(500)` before matching IDs and keys | IDs and canonical keys use authorized database queries first. Name search remains bounded to 500, with an explicit clarification on overflow rather than an incomplete absence claim. |
| Team/group resolution could select the first ambiguous match | `FirstOrDefault` on partial team and group names | Normalized candidate sets must contain exactly one match before preparing a write. |
| Duplicate project proposals bypassed raw name comparison | Existing `Release Tracker` did not prevent a proposal for `ReleaseTracker` | Compare normalized tenant-filtered names, and reject duplicate names already proposed in the current answer. Stream names to bound memory. This is not a cross-request database uniqueness constraint. |
| Failed lookup could lead to an unsolicited new project | Tool orchestration could proceed from an unsuccessful project lookup to project creation | After a failed/ambiguous/overflow lookup, the creation tool requires an explicit new-project request; task requests require clarification instead. Both provider prompts also state this rule. |
| Invalid/ambiguous task dates were silently dropped or culture parsed | `03/04/2027`, `tomorrow` and `2027-02-30` still produced task proposals | Supplied dates must be valid `yyyy-MM-dd`. Optional null remains supported. Unsupported date fields such as `end_date` require clarification; start and due dates persist separately. |
| Local-model project/task completion text could precede confirmation | Write buffering covered narrow reminder/message and deterministic commands | Buffer explicit local write requests and report application proposal/completion states and tool failures. Project/task commands cannot show a model's invented completion. This guard is intentionally limited to recognized imperative requests; it is not a general semantic hallucination detector. |
| Production troubleshooting required scanning individual traces | Tracker offered totals and per-run traces | Owner/admin dashboard ranks intent paths by p95 and counts error categories. Summaries follow current tenant, date and filter constraints, before pagination. Missing queue metrics remain null. |
| Model evaluation could pass despite extra or duplicate tool calls | Grader used `any` expected tool match | Require exactly one expected call and matching arguments. Dataset v2 has ten synthetic selection/clarification cases. Report p50/p95 and failure rate. Three offline grader tests run in CI. |

The regression baseline ran nine identical application cases against unchanged `main`: **1 passed, 8 failed**. Applying the initial fixes produced **9 passed, 0 failed**. These are selected failure regressions, not a production accuracy percentage. Additional regressions cover ambiguity, portfolios over 500 records, distinct persisted task dates, unsupported end dates and false completion text.

## Request lifecycle and existing safeguards

1. `frontend/src/features/ai/AiPage.tsx` submits authenticated SSE requests through `askAi`, includes the client's timezone, and binds typed approval to the displayed message/action/kind when exactly one card is pending.
2. `AiWorkspaceController` calls `AiAgent.PrepareAsync` before opening the stream. Conversation ownership, tenant context, feature access, credits and attachments are checked and the user message is saved.
3. `AiAgent.StreamAsync` applies the execution deadline, tier routing and deterministic paths. Local greetings, confirmations, reminders and supported structured commands bypass inference. The new project-status recognizer uses the existing authorized report tool and charges zero inference credits. Compound requests retain reasoning/tool orchestration.
4. Model requests use bounded history/context and the permission-checked toolbox. `AiInferenceGate` shares process-wide concurrent slots and bounded queue entries between one-shot and streamed clients. Queue timeout, model timeout and user cancellation are controlled; local requests are not automatically retried. Warm residency uses the configured keep-alive. No startup model download was added.
5. Proposal state and immutable execution metadata live in `AiMessage.ActionsJson`: plan version, tenant/user, payload hash, dependencies and expiry. Confirmation claims use database compare-and-swap. Business services recheck permissions and write state. In-app sends verify the exact persisted message receipt; reconciliation never resends a mutation.
6. Saved replies record correlation, intent, provider/model, queue/load/prompt/generation timings when the provider supplies them, database and tool timing, action state, attempts and error codes. Tracker output omits private conversation text and tool arguments. Cross-tenant and non-admin access are regression tested.

An unbound `yes` deliberately checks only the latest answer. After an intervening answer, use the exact card/binding; an older action must not be selected implicitly. A resumed bound confirmation is tested, and repeated confirmations cannot duplicate the message. Expired, failed and ambiguous cards remain controlled conflicts; no automatic retry is introduced.

## Retrieval, inference and evaluation limits

Structured project/work facts come from application queries/services. Document reads enforce access before returning bounded chunks; existing tests cover another tenant's document denial. Workload, history and forecast tools already calculate structured facts. No vector database, paid provider, automatic training or new service was added.

The repository documents Railway plus Ollama and a Qwen tag, but this session does not independently establish the deployed tag/runtime version, CPU quota, RAM cap, context settings, replica count, volume mount or storage headroom. No configured Ollama/Railway environment variables or connected Railway tool were available at review time. Queue-full and deadline logs alone do not establish the cause of production latency. Application capacity limits are per API process, so multiple replicas require a verified provider/shared capacity limit.

Provider/tool-selection evaluation does not execute writes. Text-only cases check for a nonempty answer without tools; they do not certify semantic correctness. Application regressions validate entity resolution, authorization, task dates, proposal persistence, duplicate prevention and message receipts with scripted model transport. Actual-model intent accuracy, false-success/hallucination rate, verified action success, duplicate write rate and timeout rate still require a reviewed end-to-end dataset and production-equivalent runs. No model comparison or fine-tuning result is claimed.

Run the existing provider benchmark from a network that can reach the private Ollama service, with installed tags only and identical settings:

```sh
export OLLAMA_BASE_URL=http://ollama.railway.internal:11434
python tools/ai-evaluation/benchmark.py --model '<installed baseline tag>' --model '<installed candidate tag>' --threads '<actual quota>' --repeats 10 --output /tmp/agent-models.json
```

Use `scripts/ai/benchmark-models.py` with the real server PID where Linux process monitoring is available to compare CPU and peak resident memory. Record runtime/tag/quantization, CPU/RAM limits, context and output caps, warm/cold conditions and storage mount alongside results. Neither script should be treated as a production SLA measurement. Do not download a candidate or resize a volume until capacity and cost have been reviewed. Never use unreviewed sensitive production conversations as training data.

## Validation and rollout

- The same nine baseline regressions improved from 1/9 to 9/9; model calls on the new structured project-status path are zero.
- Local affected backend suite: **97 passed, zero failed/skipped**. Full SQLite/PostgreSQL CI results are recorded in the associated pull request. The relative-date test now uses the application's bundled timezone provider instead of OS-specific `TimeZoneInfo`, allowing the same test to run under Windows invariant globalization.
- Frontend validation: 70 tests passed; type checking and production build passed; lint had zero errors and 75 existing warnings. Offline provider-grader tests: 3 passed.
- No schema/migration, inference service configuration, resource allocation or recurring cost change. Normalized duplicate checks read existing tenant project names; CPU/query cost should be measured for very large portfolios. Name lookups over 500 visible projects explicitly request a key/ID.
- Deployment and production verification are **not established by merging code**. Before rollout, confirm Railway's deployed revision and actual AI configuration, snapshot/verify database backups, inspect service health, and run non-destructive authorized greetings/lookups. Verify a reviewed action only in a controlled test workspace; do not send uncontrolled real messages.
- Compare Tracker slow-path/error summaries with provider load/prompt/generation and Railway CPU/RAM metrics. Measure representative p50/p95 and queue/timeout rates before asserting a production speed improvement. The current regression evidence measures correctness and inference avoidance, not production latency.
- Rollback: redeploy the previous API/web revision (`bb84ea2`) or revert this pull request's merge commit. No database downgrade or model/volume change is required. Preserve saved actions and receipts; never clear them or resend interrupted actions as a rollback step.
