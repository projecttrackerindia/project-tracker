# Local AI recipient resolution and task routing

This change addresses the October 10 conversation containing `sivaredy`, `sivareddy`, and `siva reddy`, missing message content, and current-task questions. It builds on the verified messaging/confirmation implementation documented in [AI-MESSAGING.md](AI-MESSAGING.md).

## Root causes and resulting behavior

| Before | After |
| --- | --- |
| Recipient matching used case-insensitive literal names and substrings, so `sivareddy` could not match `Siva Reddy`. The synthetic messaging tests previously registered a person literally named `Sivareddy`. | All existing tools share a resolver that normalizes Unicode, casing, spaces and punctuation. Exact email/ID matching remains strict. A long name can match one insertion, deletion or substitution when a single authorized member matches. Multiple normalized/close matches require clarification. Tests now also register `Siva Reddy`. |
| A message request without content fell through to the LLM and could produce an unrelated reminder error. | Missing-content commands ask for the exact message and display the resolved recipient without invoking a model or creating an action. |
| `a Hi message` could include the grammatical article in the proposed body. | The article describing the message is removed; quotes preserve literal content such as `"a Hi!"`. The preview still displays the exact final content before approval. |
| `Confirm sending the message` was outside the recognized approval phrases. | Backend and frontend recognize this explicit phrase. Existing exact proposal ID/user/tenant/kind validation, expiry, atomic claim and stable execution ID still apply. Conditional or differently targeted statements are not treated as approval. |
| Current-task questions used a model/tool/model round trip. The generic work tool capped the result and allowed the model to interpret an empty result. | Recognized current-task questions call the existing permission-filtered WorkItemService and render its live result directly. Answers show task key/title, current status, due date, overdue indicator and project. A second query distinguishes no assigned tasks from assignments that are completed/cancelled. |
| The generic tool showed only 40 items without a continuation route. | The new project-task route fetches 41 rows to detect another page and displays 40, with an explicit next-page command. Task ordering is stable across identical snapshots, including priority, modification time and ID. |
| Application replies still constructed model context unnecessarily. | Application routes skip model context/history construction. The tracker records intent, deterministic intent confidence, routing time and the direct service timing without recording request bodies in execution metadata. |

## Supported fast commands

- `Hi`
- `Can you send a Hi message to Sivareddy?`
- `can you send is that project completed message to sivaredy`
- `Can you send a message to Siva Reddy?` (asks for content)
- `Which task is currently Sivareddy doing?`
- `show tasks for Siva Reddy page 2`
- `Yes` or `Confirm sending the message` after a single matching pending message proposal

Compound or unrecognized questions remain on the local model reasoning route. The new direct task route reads project tasks only. It explicitly says its scope and does not claim that an empty project-task result proves a person has no operational work, issues or action items.

## Safety and delivery

Recipient candidates are active, non-guest members of the current tenant. Guests cannot enumerate members. No alias records were found/introduced, and the resolver never invents an identity. Normalized name collisions and equally close typo candidates cannot silently select a recipient. Task reads explicitly require task module view access and keep the normal project and tenant database filters.

Message proposals continue through the existing confirmation and action runner. Actual sending uses Project Tracker's internal ChatService and persisted ChatMessages, with a verified saved message ID. External WhatsApp/SMS/Slack/Telegram integrations remain unsupported. Persisted delivery does not prove the recipient has read a message.

## Measurements and validation

Warm in-process API measurements (10 requests per route, SQLite, local model transport configured to throw if called):

| Route | Mean | p95 | Model calls |
| --- | ---: | ---: | ---: |
| Greeting | 9.03 ms | 9.51 ms | 0 |
| Missing-content clarification | 9.41 ms | 9.79 ms | 0 |
| Current-task lookup with no assignments | 12.82 ms | 16.87 ms | 0 |

These measure the complete request through the test HTTP server and real application persistence. They exclude Railway networking and Ollama inference. There is no controlled before/after Railway benchmark: this workspace has no live Railway/Ollama connection. Before this change, the missing-content and task routes depended on model inference; after, the regression tests require zero model calls. The earlier production cold/warm `Hi` measurements cannot establish latency for these different requests.

Focused validation passed 56 tests before the final additional missing-content variant. The complete final backend suite passed **883 tests, 0 failures, 0 skipped** (7 minutes). Frontend validation passed **68 tests**, TypeScript checking and production bundling; lint reported **0 errors and 75 existing warnings**.

Regression coverage includes the exact observed spellings; literal approved content and verified persistence; missing content; normalized collisions; close candidate ambiguity; email typo rejection; unsafe confirmation wording; concurrent/repeated confirmations; stale and foreign confirmations; unsupported channels; completed, overdue and unassigned tasks; 41-task pagination; module denial; and foreign-tenant tasks. The model transport is mocked/disabled, while messaging and task services execute against SQLite. No live Railway delivery or PostgreSQL integration test is claimed.

## Remaining limits

- Broader CRUD, complex reasoning and unrecognized phrasings can still invoke the installed local model; CPU-only 7B cold starts are not eliminated.
- Missing-content clarification does not persist a separate recipient draft: send a complete `Send <exact content> message to <name>` command next.
- No persistent user alias management or typo matching of emails exists. Highly uncertain names need a full name/email or a selection on a new request.
- Project-task pages support offsets up to 10,000 and are live reads, not immutable snapshots. Data changed between pages can move an item; rerun from page 1 when consistency matters.
- The generic mixed-work LLM tool retains its prior capped list. Pagination here applies to the new project-task route.
- Intent confidence describes recognition of a deterministic command pattern; it is not a calibrated identity confidence or a guarantee of LLM correctness.
- No Railway variable changes, new model downloads, volume deletion, paid dependency or schema migration is required by this change. Deployment and a real production smoke test still need verifying.

## Files changed

- `backend/src/ProjectManagement.Application/Features/Ai/AiPersonMatching.cs`: authorized candidate normalization and conservative matching.
- `backend/src/ProjectManagement.Application/Features/Ai/AiReadCommands.cs`: single-intent project-task recognition.
- `backend/src/ProjectManagement.Application/Features/Ai/AiMessageCommands.cs`: missing-body detection, grammatical article handling and approval wording.
- `backend/src/ProjectManagement.Application/Features/Ai/AiToolbox.cs`: shared recipient resolution, focused clarification, permission-checked task results.
- `backend/src/ProjectManagement.Application/Features/Ai/AiAgent.cs`: application routes, context avoidance and execution metadata.
- `backend/src/ProjectManagement.Application/Features/Ai/AiExecutionTrace.cs`: optional compatible intent fields.
- `backend/src/ProjectManagement.Application/Features/WorkItems/WorkItemService.cs`: bounded task offsets and stable task ordering.
- `backend/src/ProjectManagement.Tests/AiIntentMatchingTests.cs` and `AiMessageSendingTests.cs`: matching, state, persistence, task accuracy and timing regressions.
- `frontend/src/features/ai/AiPage.tsx`: matching explicit confirmation vocabulary.
- `frontend/src/features/ai/AgentTrackerPage.tsx`: intent and routing time in the trace view.
- This document: results and operating limits.
