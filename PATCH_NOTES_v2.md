# Patch v2: encrypt AI/SMTP secrets at rest, bound AI chat context, add Daily Briefing

This builds on the previous patch (BYOK + platform default AI). Three
independent changes — apply any subset, they don't depend on each other
except where noted.

## 1. `workspaces.ai_api_key` and `smtp_password` are now encrypted at rest

**Problem found:** both columns were stored and read back as plain text,
even though the app already has a working per-user Fernet encryption
utility (`vault_encrypt` / `vault_decrypt`, used elsewhere for vault
cards). A workspace's own Anthropic key — and the mailbox password used to
send on the workspace's behalf — sitting in plaintext in Postgres is real
exposure if that table is ever dumped, backed up insecurely, or read by
anyone with DB access.

**Fix:** reuse the existing `vault_encrypt`/`vault_decrypt` functions,
keyed on `workspace_id` (passed in the same argument slot the vault
functions use for `user_id` — it's just an HKDF-derivation string, and a
workspace id is as good a scoping key as a user id for a workspace-level
secret).

- `update_workspace()` (PUT /api/workspace): encrypts both values before
  the UPDATE.
- `get_workspace()` (GET /api/workspace): decrypts both before returning
  them to the settings form, so the UI behaves identically to before.
- The SMTP-send path in `send_email()`: decrypts `smtp_password` right
  before building the SMTP config.
- `ai_provider.resolve_ai_key()` gained an optional `decrypt_fn` parameter.
  Both call sites in `app.py` (`/api/ai/chat`, `/api/ai/generate-docs`)
  now pass `decrypt_fn=lambda v: vault_decrypt(v, wid())`.
- `intelligence.py`'s `register_intelligence()` gained a `vault_decrypt`
  parameter (passed from `app.py`); its internal `_resolve_ai()` uses it
  the same way, so allocation/routing/follow-up/briefing generation all
  correctly decrypt a workspace's own key too.

**No migration needed.** `vault_decrypt` already falls back to returning
the raw value unchanged if it isn't a valid Fernet token (this is the
same fallback the vault-card feature already relies on for pre-encryption
rows) — so existing plaintext keys keep working immediately, and get
silently upgraded to encrypted form the next time that workspace edits
its key/password in Settings. No forced re-save, no downtime.

**Depends on `VAULT_ENCRYPTION_KEY` already being set** (or the app falls
back to a file-based key on the local disk — fine for dev, weaker in
prod since the key then lives next to the data it protects). This isn't
new to this patch; it's the existing vault system's requirement, and it
now also covers these two columns.

## 2. `/api/ai/chat` no longer dumps the entire workspace into every prompt

**Problem found:** every chat message re-queried and included *every*
project and *every* task in the workspace with no limit. Fine at 50
tasks; at 5,000+ it's slower, meaningfully more expensive per message,
and risks the most important rows (what you'd actually want the AI to
reason about) getting crowded out or truncated by the model's own context
window.

**Fix:** two new env-configurable caps —
`AI_CHAT_MAX_TASKS_IN_CONTEXT` (default 200) and
`AI_CHAT_MAX_PROJECTS_IN_CONTEXT` (default 100). Below the cap, behavior
is byte-for-byte identical to before. Above it:
- Projects are ordered soonest-deadline-first.
- Tasks are ordered by priority (urgent → high → medium → low), then by
  due date — so what fits in the prompt is what's actually worth asking
  about.
- A `GROUP BY stage` count is queried separately and appended as a one-line
  note ("showing the 200 highest-priority/soonest-due of 4,312 total
  tasks, breakdown: backlog:1200, in_progress:340, ...") so the model
  knows the true scope instead of silently assuming the visible sample is
  everything.

`/api/ai/generate-docs` gets the same `LIMIT` on its two queries (it
already truncated the *rendered* context to 3000 chars, but was still
pulling every row into Python memory first to build that string — this
fixes the underlying query, not just the truncation).

## 3. New capability: Daily Briefing (`intelligence.py`)

A fifth intelligence feature, additive to the existing four
(allocation / routing / follow-up / dashboard). Turns the dashboard's
already-computed numbers (project urgency, team load, pending suggestion
counts, overdue tasks, open tickets) into a short, plain-English summary
— "2 projects are at risk, Priya is overloaded, here's what to look at
today" — instead of making a manager read through tables.

- **Read-only** — unlike the other three features, it never proposes an
  assignment or a message to send, so there's no approve/reject step.
- `POST /api/intelligence/briefing/generate` — generates a fresh one
  (counts as one AI call against the workspace's existing quota/BYOK
  key, same as everything else).
- `GET /api/intelligence/briefing/latest` — returns the last stored one
  with no AI call, for cheap dashboard loads.
- New table `intelligence_briefings` (id, workspace_id, body, stats_json,
  created, created_by) — auto-created by the existing `_ensure_schema()`
  path, no manual migration.
- Added to the built-in `/intelligence` dashboard as a card at the top,
  with a "Generate briefing" button.

## Files changed

- `ai_provider.py` — `resolve_ai_key()` gained `decrypt_fn` param.
- `app.py` — encrypt-on-write / decrypt-on-read for `ai_api_key` and
  `smtp_password`; bounded, prioritized queries in `/api/ai/chat` and
  `/api/ai/generate-docs`; two new env-var constants; `register_intelligence(...)`
  call now passes `vault_decrypt`.
- `intelligence.py` — new `intelligence_briefings` table, `_briefing_stats()`
  / `_generate_briefing()`, two new routes, dashboard HTML/JS card;
  `register_intelligence()` gained `vault_decrypt` param, used in `_resolve_ai()`.

## How to apply

1. Drop in the updated `app.py`, `intelligence.py`, `ai_provider.py`
   (full-file drop-ins again, not diffs).
2. No new environment variables required. `VAULT_ENCRYPTION_KEY` should
   already be set from the vault-card feature; if it isn't, encryption
   silently falls back to a file-based key (same behavior the vault
   already had) rather than failing.
3. Redeploy. The new `intelligence_briefings` table is created
   automatically on first request that touches `register_intelligence()`'s
   schema init, same as the other intelligence tables.

## Testing checklist

- [ ] Save a workspace's Anthropic key in Settings → reload Settings →
      the key displays correctly (proves encrypt-then-decrypt round-trips).
- [ ] Query the `workspaces` table directly in Postgres → `ai_api_key`
      and `smtp_password` are no longer readable plaintext for a
      workspace saved *after* this patch.
- [ ] A workspace that saved its key *before* this patch still works in
      `/api/ai/chat` without re-entering it (proves the plaintext fallback
      in `vault_decrypt` covers old rows).
- [ ] SMTP email sending still works for a workspace using workspace-level
      SMTP settings (not the Resend/env fallback).
- [ ] `/api/ai/chat` on a workspace with >200 tasks: response still
      answers correctly about high-priority/overdue items, and the system
      prompt (visible in server logs / `raw` field) shows the "showing N
      of M" note rather than every single task.
- [ ] `/intelligence` dashboard → "Generate briefing" produces a short
      paragraph referencing real project/people names from that workspace,
      not generic filler. Reload the page — the same briefing is still
      shown (from `/latest`) without a new AI call.
- [ ] Same LIMIT_EXCEEDED / NO_KEY handling as the other three intelligence
      endpoints when the platform quota is hit or no key is configured.
