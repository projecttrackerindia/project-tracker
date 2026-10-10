# AI orchestration, reliability and measurement

This increment implements the repository work from the full performance/accuracy specification. It follows the recipient/task fix merged in `c4975a6`; see [AI-INTENT-ROUTING.md](AI-INTENT-ROUTING.md) and [AI-MESSAGING.md](AI-MESSAGING.md). It does **not** claim that the entire ten-phase transformation or live model comparison has been completed.

## Audit and evidence

| Finding | Evidence | Priority and change |
| --- | --- | --- |
| Known reads and simple CRUD still depended on a model deciding to call a tool, then explaining its output. | The previous AiAgent only recognized greetings, narrow reminders/messages and person-task reads. A generic local model turn remained the fallback for project rename, assignment and directory/work summary reads. | High: central AiCommandPlanner dispatches known requests through existing services/tools, without a model turn. |
| Actions had atomic confirmation and message idempotency, but little durable lifecycle metadata. | ActionsJson contained proposed/running/done states; expiry was based on the answer timestamp. No per-action approval/execution timestamps, immutable payload hash, version or dependency list was stored. | High: additive typed execution metadata is stored with the existing proposal. Exact user/tenant/payload binding and prerequisite success are checked before execution. |
| A project-dependent task could be confirmed ahead of project creation, then resolved by a mutable name. | ConfirmAll serialized proposals but an individual card did not express prerequisites. ProjectIdAsync could use the first name match. | High: persist explicit dependencies and use the actual prerequisite project result ID, even when the project is renamed later. Legacy cards keep their original behavior. |
| A process interrupted after a message was persisted could leave a running card. | A stable ChatMessage ID prevented duplicate delivery, but there was no supported receipt reconciliation endpoint. | High: owner-only receipt reconciliation checks the exact message body, sender, recipient membership and tenant. It never sends or retries a mutation. |
| Failed cards offered a button that the backend intentionally rejected. | UI “Try again” called ConfirmAsync although non-proposed states returned AI_ACTION_HANDLED. | High: remove this misleading retry. Interrupted/failed messages offer a read-and-reconcile operation; other failures instruct the user to check the application. |
| Failed action traces were always labelled partial, including when nothing succeeded; dismissal could leave an awaiting-confirmation trace. | The previous ConfirmAsync aggregate used any failed -> partial. DismissAsync did not update execution outcome. | High: lifecycle-derived failed/partial/cancelled/executing outcomes and separate action stage timings. |
| Query overhead and cold model loading could not be separated in a trace. | Execution traces stored model wall time and token counts, but ignored native Ollama load/prompt/generation durations and EF command timings. | High: scoped EF command counters, preparation timing, local queue timing and native runtime metrics. A regression found that AsyncLocal-only scopes disappeared across SSE yield boundaries; request-scoped roots now survive streaming. |
| Complete inference evaluation was unavailable on this host. | Local Ollama 0.12.3 installed and started on loopback. Both registry.ollama.ai and Hugging Face returned HTTP 403, including an approved network attempt. No model weights could be loaded. | Blocked: preserve the current model. Add an opt-in evaluation harness; do not invent a CPU/RAM/model quality comparison or select a smaller production model. |

User-provided production evidence also showed a 62.58-second simple request with approximately 60.77 seconds spent loading the 7B model, followed by a warm 0.37-second repeat. These are historical raw inference measurements, not a controlled before/after application benchmark. Hosting quota, per-service CPU limits, live PostgreSQL query timings and browser/network latency could not be inspected from this workspace.

## Architecture before and after

Before: AiAgent prepared a request, selected a tier, built context, streamed model/tool turns, saved proposals and executed confirmed actions through AiActionRunner. This already preserved application RBAC, tenant filters, bounded loops, local primary routing, confirmed writes, document access checks and message idempotency.

After: the existing agent remains the orchestration boundary. AiCommandPlanner produces a typed known-command plan or delegates to the reasoning path. Read plans retrieve authoritative application results and render them directly. Write plans use the existing proposal tools, validate structured arguments, then wait for confirmation. No CRUD endpoint or authorization layer is bypassed. ActionsJson is the persistent action authority; assistant prose is never used as proof of approval or completion.

Known commands now include message drafting, missing-content clarification, reminder creation/revision (including tomorrow in the caller's zone), person-task pages, directory/project lists, caller work summary, project rename, task assignment and task status changes. Compound or uncertain requests remain on the local reasoning agent. Invalid or ambiguous entities produce targeted errors rather than wider queries or guessed IDs.

AiActionExecution stores immutable plan ID/version, tenant/user binding, payload hash, prerequisites, proposal/expiry/approval/execution/completion timestamps, attempts, execution identity and database timing. All new plans are immutable version 1; a changed proposal receives a new plan/action identity. The DTO exposes lifecycle information without exposing the private binding/hash. Existing cards without metadata retain their original safeguards.

The frontend binds typed approval/cancellation to the displayed action, shows the exact message body, disables expired/prerequisite-blocked cards, uses a synchronous single-action lock and refreshes state. ConfirmAll remains sequential and stops after failure. Dependent writes are not parallelized. Dismissal and receipt reconciliation publish their state/audit updates in database transactions.

## Execution and recovery guarantees

- Confirmation requires the exact owner/tenant/action state and an unexpired, unmodified plan. Missing prerequisites are rejected.
- Atomic state claims prevent simultaneous confirmations from starting the same action. New approval timestamps and executing traces are persisted with that claim.
- Approved messages retain the stable execution ID and existing ChatService idempotency. A successful response references a persisted message receipt.
- Project rename and project-task assignment/status results are checked against the persisted records before reporting completion. Created records expose result IDs from the existing saving services.
- Recovery can complete a previously approved running/failed in-app message **only** after verifying its exact existing receipt. A running action must first pass its execution deadline. Recovery never sends a message and rejects an absent/mismatched receipt. Repeated recovery cannot duplicate delivery.
- Other interrupted operations are not automatically replayed. Cross-service atomicity, compensation and universal crash-replay idempotency for every action are not implemented. An external email/meeting or compound action can have partial side effects; failure remains truthful and requires inspection.
- Existing auto-created documents keep their prior policy; this change does not expand automatic mutation to other kinds.

## Measurements and test interpretation

Latest focused-run warm HTTP measurements: real application code and SQLite persistence, in-process HTTP transport, model transport configured to fail if invoked; 10 samples per route after warm-up.

| Route | p50 | p95 | Mean | Model calls |
| --- | ---: | ---: | ---: | ---: |
| Greeting | 4.06 ms | 6.47 ms | 4.48 ms | 0 |
| Missing-content clarification | 4.26 ms | 4.49 ms | 4.28 ms | 0 |
| Person-task lookup, no assignments | 5.82 ms | 6.12 ms | 5.80 ms | 0 |

The prior increment's same-host samples recorded means/p95 of 9.03/9.51 ms, 9.41/9.79 ms and 12.82/16.87 ms respectively. They did not record p50. These are short samples from separate runs with different background load; they cannot establish a causal speedup, a sustained latency SLO or production p95. The more reliable verified change is **zero model calls** for the expanded known commands. Their former paths required one or more model turns, depending on tool selection. Local model and Railway end-to-end before/after measurements remain unavailable.

Execution trace DurationMs and first-token timing now include server preparation plus orchestration. Database timing includes preparation and stream commands before the final trace snapshot; per-action counters cover claimed execution. EF duration measures command execution, excluding result materialization. HTTP authentication middleware, response transfer and browser rendering are outside these stage counters. The HTTP benchmark includes request preparation and response handling in the test server.

Agent Tracker preserves admin-only tenant access and sanitized traces. It adds exact intent filtering, p50, total model calls/database commands, preparation/queue/native runtime metrics and action wait/execution/attempt metrics. SQL, parameters, request text, message bodies and payload bindings are not retained in these metrics. Existing optional trace retention remains in place.

Focused compatibility validation passed **122 tests** on the final backend code. These exercise real chat/task/project/reminder services and SQLite persistence; only inference/network transports use test doubles. No live Railway delivery or production-model quality claim is made. The complete final backend suite passed **906 tests, 0 failures, 0 skipped**, in **7 minutes 49 seconds**. The initial full run found an invitation-role error wording regression, which was corrected and covered by a new unit test; a later run exposed an unrelated audit-test false positive from a random ID containing `1234`. The audit test now uses a distinctive secret marker, and the clean complete suite passed after both corrections. Frontend validation passed **68 tests**, type checking and the production build. Lint reported **0 errors and 75 existing warnings**.

## Model evaluation and controlled learning

`evaluation/ai/requests.v1.json` contains 18 synthetic, versioned cases: greeting, normalized/misspelled/ambiguous people, content preservation, missing fields, task lookup, project rename, assignment, multi-step interpretation, relative dates, hostile email extraction, unsupported integrations, missing confirmation context, retries, unauthorized SQL and failed-action context.

`scripts/ai/benchmark-models.py` compares installed models using both JSON-schema output and native tool calls. It records cold/warm latency, first-token time, native token/load/prompt/generation metrics, expected-field accuracy, structured-output validity and optional local process-tree CPU/RSS. It never executes application actions, downloads/deletes models or changes application settings. Process RSS is summed across the supplied local server PID and its children; it is not unique RAM or a Railway billing estimate. Without a local server PID, resource measurements remain unavailable. Hardware labels identify the benchmark client's host.

Example, on a dedicated host with sufficient disk and **both models already installed**:

```sh
python scripts/ai/benchmark-models.py \
  --models qwen2.5:7b-instruct-q4_K_M qwen2.5:3b-instruct-q4_K_M \
  --url http://127.0.0.1:11439 --threads 2 --context 2048 \
  --server-pid YOUR_LOCAL_OLLAMA_PID --output /tmp/project-tracker-model-comparison.json
```

The harness explicitly unloads each specified model to measure cold startup, so use a dedicated evaluation server rather than a shared production Ollama instance. Run repeated comparable trials and separate inference from application execution evaluation. Four harness unit tests validate the runner utilities/dataset only; they do not simulate model-quality success. Tool validity is assessed by one correctly named call with valid arguments. Missing completion streams count as failures.

Existing user profiles/preferences, feedback and verified proposal outcomes remain the controlled learning mechanism. Existing authorized document search/chunks include document IDs, revisions and citations; current application services remain authoritative for structured facts. No unverified conversation is promoted to a fact, no automatic training or self-modifying code is introduced, and no embedding/vector infrastructure is justified or provisioned without volume/quality evidence.

## Deployment requirements, costs and remaining work

No new package, migration, paid model provider, production data mutation, Railway variable edit or infrastructure purchase is required. New lifecycle and trace fields are optional JSON in the existing storage. Keep the current installed model and existing local-primary settings documented in [AI-OPERATIONS.md](AI-OPERATIONS.md). The user's almost-full Ollama volume was not wiped or changed.

Next priorities requiring further evidence:

1. Run real 7B-versus-smaller-model evaluations on an allowed, isolated inference host, then measure actual Railway cgroup CPU/memory/disk and cost. Do not select a model or reduce context solely by size.
2. Deploy and run a real sender/recipient smoke test; measure browser/network end-to-end p50/p95 and correlate middleware auth timing with the agent trace.
3. Expand validated command grammar/retrieval based on corrected user requests and the versioned evaluation dataset. Missing-content clarification still requires a complete follow-up command; it does not persist a separate recipient/body draft.
4. Add recovery/idempotency support per additional mutation service only when its side effects can be verified safely. Universal cross-service compensation and arbitrary multi-step transactional replay remain unsupported.
5. Evaluate PostgreSQL-specific behavior and larger tenant/document workloads. The generic mixed-work tool's capped list and advanced memory/fact provenance are not replaced by an unrestricted data or vector layer.

These limits prevent a claim that the agent can perform every request. Its capabilities remain the application's implemented services and the caller's permissions.

## Files changed

- `backend/src/ProjectManagement.Api/Controllers/Workspaces/AgentTrackerController.cs`
- `backend/src/ProjectManagement.Api/Controllers/Workspaces/AiWorkspaceController.cs`
- `backend/src/ProjectManagement.Application/DependencyInjection.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AgentTrackerService.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiActionPlan.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiActionRunner.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiAgent.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiAgentModels.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiChat.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiCommandPlanner.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiDatabaseTelemetry.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiExecutionTrace.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiFastReminder.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiMessageCommands.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiToolInputValidator.cs`
- `backend/src/ProjectManagement.Application/Features/Ai/AiToolbox.cs`
- `backend/src/ProjectManagement.Infrastructure/DependencyInjection.cs`
- `backend/src/ProjectManagement.Infrastructure/Persistence/AiDatabaseCommandInterceptor.cs`
- `backend/src/ProjectManagement.Infrastructure/Services/AiBackupChat.cs`
- `backend/src/ProjectManagement.Tests/AiMessageSendingTests.cs`
- `backend/src/ProjectManagement.Tests/AiPlatformReliabilityTests.cs`
- `backend/src/ProjectManagement.Tests/AiPlatformUnitTests.cs`
- `backend/src/ProjectManagement.Tests/LocalAiRuntimeTests.cs`
- `backend/src/ProjectManagement.Tests/DocumentWorkflowTests.cs` (distinctive audit secret marker avoids random-ID false positives)
- `deploy/AI-PLATFORM-RELIABILITY.md`
- `evaluation/ai/requests.v1.json`
- `frontend/src/features/ai/AgentTrackerPage.tsx`
- `frontend/src/features/ai/AiPage.tsx`
- `frontend/src/features/ai/AiParts.tsx`
- `frontend/src/features/ai/aiApi.ts`
- `scripts/ai/.gitignore`
- `scripts/ai/benchmark-models.py`
- `scripts/ai/test_benchmark_models.py`
