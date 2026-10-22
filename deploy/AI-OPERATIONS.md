# AI provider operations

Message sending and confirmation handling: see [AI-MESSAGING.md](AI-MESSAGING.md). Agent Tracker, traces and alerts: see [AI-AGENT-REVIEW.md](AI-AGENT-REVIEW.md).

## Provider policy

Google Gemini on Vertex AI is the only production model provider. The API signs in with the server's own Google service account, requests are billed to the Google Cloud project and served in `asia-south1` (Mumbai). No self-hosted or local model is deployed or supported; the earlier Railway-era local-model configuration is retired and its settings (`Ai:Fallback:Wire`, `NumCtx`, `NumThread`, `KeepAlive`) no longer exist.

| Setting | Production value | Purpose |
| --- | --- | --- |
| `Ai__PrimaryProvider` | `gemini` (default) | Which provider answers first |
| `Ai__Gemini__Enabled` | `true` | Explicit enablement; a key alone never enables a paid provider |
| `Ai__Gemini__Vertex` | `true` | Service-account sign-in on Vertex AI; no API key stored |
| `Ai__Gemini__ProjectId` | the Google Cloud project | Billing and quota project |
| `Ai__Gemini__Location` | `asia-south1` | Region; keeps data in India |
| `Ai__Gemini__Model` | `gemini-3.5-flash-lite` | Default model; tiers may override per question |
| `Ai__Gemini__TimeoutSeconds` | `60` | Per-request deadline; the HTTP client's outer guard is 10 minutes for streamed turns |
| `Ai__Gemini__RequestsPerMinute`, `InputTokensPerMinute`, `RequestsPerDay` | pilot ceilings | Admission control, enforced in Redis across API instances |
| `Ai__AllowAnthropic` | `false` | Anthropic is optional and must be enabled explicitly together with `Ai__PrimaryProvider=anthropic` |
| `Ai__Fallback__*` | optional | A hosted OpenAI-compatible backup (Groq, OpenRouter, Mistral) used only when Gemini fails before any output has streamed |

Start-up validation: a provider value outside `gemini`, `anthropic` or `local` refuses to start; Gemini that is enabled without Vertex or a key refuses to start; Gemini that is not enabled leaves the assistant off (`AI_NOT_CONFIGURED`) so development and CI environments run without AI configuration.

## Fallback behaviour

- One-shot calls (search, risk, triage, agent analysis): Gemini first; on an unavailable response the backup endpoint answers once, if configured.
- The streamed AI workspace: Gemini first; the backup is used only before any output has streamed and only when the conversation carries no provider-specific tool history, so no action is replayed. A mid-stream failure is surfaced to the person with a retry affordance rather than silently restarted on another model.
- Every answer records which provider and model answered, in the conversation and in the audit trail.

## Cost and capacity

- Credits: every AI call reserves credits through `AiCreditService` before it is sent; plan limits and per-organisation exceptions apply.
- Admission: Gemini requests are admitted per minute and per day through the Redis-backed `GeminiAdmission`; a refused admission returns `AI_BUSY` and is never retried automatically.
- Provider cost in USD is estimated per answer from token usage and shown under Admin → AI usage.

## Operational checks

1. Admin → System health shows the configured provider and the last successful call.
2. `GET /api/v1/ai/diagnostics` reports configuration without sending inference; for Gemini it reports `AI_HEALTH_UNSUPPORTED` by design, since there is no model list to probe.
3. A deploy that changes any `Ai__*` value is a configuration change: record it in the release note and run the AI smoke script before sign-off.
