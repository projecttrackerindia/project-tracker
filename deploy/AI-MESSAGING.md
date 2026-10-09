# AI message sending and confirmation

## Root cause

The previous tool catalog offered `propose_send_report`, which creates an email-report proposal (title and at least twenty body characters), but no tool for the application's existing direct chat. It could not faithfully represent a short in-app message such as `Hi`. `AiActionRunner` sent reports through IEmailSender, not ChatService.

Only the card's Confirm button called `POST /ai/messages/{messageId}/actions/{actionId}/confirm`. Typed approvals were ordinary `/ask` requests: the router/model received them as another question, along with a proposed action that had not executed. A new model proposal was not approval of the old one. This caused the observed confirmation loop. There was no frontend automatic resend loop in the inspected card handlers; they were click-driven, but had no synchronous lock against clicks before React rerendered.

## New workflow

1. `Can you send Hi message to Sivareddy?` resolves Sivareddy to one active non-guest member of the current organization and creates `send_message`. Exact command recognition bypasses inference; model-driven proposals use the same tool and cannot expand an explicitly specified message.
2. The card shows the resolved recipient, **Project Tracker chat** channel and exact final plain message body. Nothing is sent at proposal time.
3. Clicking Confirm, or an explicit supported typed approval (`yes, send it`, `confirm`, `send it`, `go ahead`), executes the existing confirmation method. Typed approvals in the UI carry the displayed assistant message ID, proposal ID and kind. The server verifies all three within the private conversation, user and tenant. Without a binding, it accepts only one pending messaging action from the latest answer before the approval question. Ambiguity is rejected; it never asks the model to infer which action to execute.
4. Confirmations expire after 24 hours. Unknown, mismatched, expired, running, completed or failed actions are rejected. The existing conditional database update claims each exact proposal before a side effect.
5. The action runner calls `ChatService.OpenDirectAsync` and `ChatService.SendAsync` as the signed-in user. Existing eligibility, membership, tenant checks, chat notification and realtime push paths apply. It verifies the saved message ID, sender, conversation and exact body before marking the card done.
6. A stable chat message ID derives from tenant, sender, assistant message ID, proposal ID and kind. The chat message primary key prevents a second record; a repeated internal service call returns the original matching stored record, while a mismatched reuse fails. Ordinary public chat requests cannot choose this internal identity.
7. The result includes `resultId` and a `/chat/{conversationId}` link. Typed approvals return a verified saved-message receipt. The frontend refreshes older card states; synchronous action locks guard single/bulk card clicks.

`propose_send_report` remains an email-report tool and is not a messaging fallback. No WhatsApp, SMS, Slack or Telegram sending integration is added. Unsupported external-channel requests fail clearly rather than being redirected silently to in-app chat. Personal workspaces and guests cannot use in-app direct messaging.

## Verification and limits

AiMessageSendingTests exercise the real application services and SQLite persistence and read the sent message through the recipient's actual chat API. The LLM transport is scripted or intentionally disabled. These are application integration tests, not real Ollama quality tests or external delivery tests. Chat notifier/presence test doubles do not establish live SignalR delivery, push notification delivery or whether a recipient read a message.

Coverage includes exact content, typed and button approvals, concurrent/repeated approvals, cross-user/tenant denial, incorrect action IDs and kinds, expiry, ambiguous approval, unavailable recipients, unsupported channels, and stable stored-message reuse in a controlled recovery scenario. The recovery test does not claim automatic crash recovery exists.

A crash after the business write can leave a proposal running or uncertain. Automatic replay is deliberately blocked; check the persisted message before recovery. Stable IDs protect a recovered in-app send from duplicate persistence. Email providers do not share this database identity: their acceptance/delivery and cross-process recovery remain separate limitations. No recipient read receipt or external delivery guarantee is claimed.

This fix introduces no paid LLM dependency or schema migration. Merging the preceding AI foundation also includes its additive ExecutionJson migration; see AI-OPERATIONS.md for that rollout and Railway settings.

## Files changed for this fix

- `backend/src/ProjectManagement.Application/Features/Ai/AiAgent.cs`: typed confirmation routing, exact binding, expiration and stable execution identity.
- `backend/src/ProjectManagement.Application/Features/Ai/AiAgentModels.cs`: optional confirmation binding and persisted-message receipt in action results.
- `backend/src/ProjectManagement.Application/Features/Ai/AiMessageCommands.cs`: bounded recognition of exact message commands and supported explicit approvals.
- `backend/src/ProjectManagement.Application/Features/Ai/AiToolbox.cs`: in-app message proposal, exact preview, recipient resolution and channel separation.
- `backend/src/ProjectManagement.Application/Features/Ai/AiActionRunner.cs`: existing chat-service execution and saved-content verification.
- `backend/src/ProjectManagement.Application/Features/Chat/ChatService.Messages.cs`: internal stable-message identity and matching stored-result reuse.
- `frontend/src/features/ai/aiApi.ts`: exact typed-confirmation request binding.
- `frontend/src/features/ai/AiPage.tsx`: binding from the displayed card, synchronous confirmation locks and action-state refresh.
- `backend/src/ProjectManagement.Tests/AiMessageSendingTests.cs`: nine application workflow, isolation, failure and idempotency regressions.
- `deploy/AI-MESSAGING.md` and `deploy/AI-OPERATIONS.md`: root cause, integration, verification scope, changed files and rollout limits.

Validation completed: all 861 backend tests passed with zero failures/skips, including the nine message-sending regressions; 68 frontend tests, type checking, production build and lint passed (75 existing lint warnings, zero errors). No live Railway message was sent and no external delivery was simulated as an integration success.
