# The organization's own Claude or ChatGPT key

An owner or admin can have the assistant answer on the organization's own AI account: **Settings › Assistant › Use your own Claude or
ChatGPT** (search "own key" or "chatgpt key").

## How it works

1. Pick **Claude (Anthropic)** or **ChatGPT (OpenAI)** and paste an API key (`console.anthropic.com` › API keys, or
   `platform.openai.com` › API keys).
2. **Check key** asks the provider for the models the key may use; that list is the proof the key works. Nothing is saved until then.
3. Choose the three models (quick answers, most questions, deep analysis). Sensible ones are suggested.
4. **Save.** The key is encrypted at rest; afterwards only its last four characters are ever shown.

Options: **On for everyone who agrees** (off keeps the key but goes back to Project Tracker's AI), and **If the key cannot answer, use
Project Tracker's AI** (for example when the account is out of credit; those answers use AI credits). With the fallback off, people see
what went wrong, and the last problem is shown to admins.

## Each person agrees once

Before a person's first question goes to the organization's provider, the assistant shows a short notice above its box and asks them
once (who the provider is, that only what they can already see is looked up). Their question waits and is sent as soon as they agree.
They can withdraw any time in **My account › Profile**. A new provider or a new key asks everyone again.

## What it changes

- Answers on the own key use **no AI credits**; the provider bills the organization.
- The assistant gets its full set of tools and instructions on the own key.
- Scheduled and background work (digests, the project agent, summaries) keeps using Project Tracker's AI.
- Answers are asked to vary their wording and shape rather than repeat a fixed template.

API: `GET/PUT/DELETE /api/v1/workspace/ai-provider`, `POST /api/v1/workspace/ai-provider/check` (owners and admins);
`GET /api/v1/ai/provider-status`, `POST/DELETE /api/v1/ai/provider-consent` (each person).
