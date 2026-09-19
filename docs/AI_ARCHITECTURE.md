# AI Layer — Architecture Summary & Plan

**Status: inspection and proposal only. No code in this document's scope has
been changed.** This is Phase 1–2 of the "add an AI layer" request — read the
existing system, document it accurately, and propose a plan before touching
anything. Say "proceed with the implementation plan" (or direct changes to
the plan below) when you want Phase 4 onward built.

## The most important finding first

**An AI chat layer already exists.** `POST /api/ai/chat` (`app.py:11674`) is
live today: authenticated, workspace-scoped, resolves a BYOK-or-platform
Anthropic key via `ai_provider.py`, builds a bounded context (projects, a
priority-sorted sample of tasks, team members), calls the Anthropic Messages
API directly, and even supports a form of tool calling — the model is
instructed to emit `<action>{"type":"create_task",...}</action>` tags in its
reply, which are regex-extracted, JSON-parsed, and executed server-side
(`create_task`, `update_task`, `create_project`, `eod_report`).

This changes the shape of "add an AI layer" from a greenfield build to an
**evolution of something that already works**. Duplicating it with a second,
parallel `/api/ai/chat`-alike would be exactly the mistake the "inspect
first" instruction exists to prevent. The plan below is written as a set of
changes to the existing system, not a new one next to it.

## 1. Existing architecture (as found)

| Layer | What's actually there |
|---|---|
| Backend | Flask 3.x, single file (`app.py`, ~19.5k lines). No ORM — raw SQL via `pg8000.native`, `?`-placeholder style. |
| Frontend | React 18 (UMD/CDN) + `htm` tagged templates, no build step. Served from `template.html`; app logic lives in the external, cache-busted `frontend.js` (see the architecture review's DEAD-01 fix, just applied). |
| Auth | Server-side session cookie (`pf_session`), bcrypt passwords, optional TOTP 2FA, Google OAuth, SAML SSO. `@login_required` decorator + `wid()` (current session's `workspace_id`) scope every route. |
| Database | PostgreSQL, ~65 tables, `CREATE TABLE IF NOT EXISTS` DDL run at startup (now automatic and lock-protected — see the architecture review fixes). No foreign keys; integrity enforced in application code. |
| Existing AI infra | `ai_provider.py` (key resolution: workspace BYOK vs. capped platform key), `intelligence.py` (separate: AI-assisted resource-allocation *suggestions* for managers to approve, and ticket auto-routing proposals — nothing there auto-applies without a human), and the `/api/ai/chat` endpoint described above. |
| Deployment | Railway, gunicorn + gevent workers, PgBouncer in front of Postgres, optional Redis for rate limiting/SSE/queues. |
| Env vars | See `.env.example` (just created — none existed before today). |
| Tests | None. CI (`​.github/workflows/ci.yml`, just added) currently runs static checks only. |

## 2. Schema surfaces relevant to AI tools

Confirmed to exist and be workspace-scoped (`workspace_id` column) — safe to
build read-only tool functions against directly:

- `tasks` (id, title, stage, priority, assignee, project, due, pct, description, tags, team_id, deleted_at, ...)
- `projects` (id, name, description, target_date, color, members, owner, ...)
- `tickets` (id, title, status, priority, type, assignee, project, ...)
- `users` (id, name, role, workspace_id, ...)
- `notifications`, `task_events` (activity/audit trail per task)

No table exists today for `ai_conversations`/`ai_messages` — chat history is
currently client-side only (`history` array passed in the request body,
truncated to the last 10 messages). **Per the "don't create tables you don't
need" instruction: adding one is a real, scoped decision, not automatic** —
see §5.

## 3. Proposed tool set, mapped to what actually exists

All of these are read-only queries the existing `ai_chat()` handler could
call instead of (or in addition to) its current single big context dump —
each one is a `SELECT` against a table confirmed above, always filtered by
`wid()` before anything reaches the model:

| Tool | Backing query | Status |
|---|---|---|
| `get_project_status(project_id)` | `tasks` grouped by `stage` WHERE `project=?` | Straightforward |
| `get_overdue_tasks(project_id?, user_id?)` | `tasks` WHERE `due < today AND stage != 'done'` | Straightforward |
| `get_team_workload(project_id?, start, end)` | `tasks` grouped by `assignee` WHERE `due BETWEEN` | Straightforward |
| `get_user_tasks(user_id)` | `tasks` WHERE `assignee=?` | Straightforward — this is "my tasks today" |
| `get_project_summary(project_id)` | `projects` + task stage counts | Straightforward |
| `get_blocked_tasks()` | `tasks` WHERE a blocked/status flag is set | **Needs a schema check** — confirm the exact column/convention `frontend.js` uses for "blocked" before building this one; don't invent a status value that doesn't match what the UI already shows. |
| `get_upcoming_deadlines(days=14)` | `tasks`/`projects` WHERE `due`/`target_date` in range | Straightforward |
| `get_project_risks(project_id?)` | Overdue count + stalled-task heuristic | **Not a stored fact today** — "risk" isn't a column anywhere; this one is a computed heuristic (e.g. overdue-count + days-since-last-update), not a lookup. Reasonable to build, but should be explicitly designed and documented as a heuristic, not presented as ground truth the way the others are. |

## 4. What Phase 4–8 of the plan becomes, concretely

Instead of a new endpoint, the shape is:

1. **Refactor `ai_chat()`'s context-building** into the named tool functions
   above (`get_overdue_tasks`, etc.), each independently callable and
   independently authorization-checked (workspace scope via `wid()`, same as
   every other route in this file — nothing new to invent here).
2. **Replace the `<action>...</action>` regex/prompt convention with
   Anthropic's native tool-use** (`tools` param + `tool_use`/`tool_result`
   content blocks) for the four capabilities that already exist
   (`create_task`, `update_task`, `create_project`, `eod_report`), plus the
   new read-only tools above. Native tool calling is more reliable than
   asking the model to hand-format an XML-ish tag inside free text, and it's
   what the pasted plan's Phase 8 asks for.
3. **Add an authorization check before executing a write action** — this is
   the one concrete gap worth calling out plainly: today, `update_task`/
   `create_task`/`create_project` actions from the AI execute unconditionally
   for any logged-in user who can reach the chat endpoint, with no check
   against that user's role/permissions (e.g. a Viewer-role account, which
   normally can't create tasks through the UI, could currently ask the AI to
   do it instead, and it would succeed). This is exactly the class of
   problem Phase 5 of the plan (authorization must happen in backend code,
   never be inferred from what the LLM decided to do) is about — fixing it
   is in scope for the first real implementation pass, not a "someday."

## 5. Conversation history — a real decision, not a default

Today: none stored server-side; the client resends the last 10 turns. Two
honest options, not a foregone conclusion:

- **Keep it client-only** for v1. Zero schema change, matches "don't create
  tables you don't actually need." Downside: no cross-device continuity, no
  server-side record for the audit log gap the architecture review also
  flagged (DEAD-04).
- **Add `ai_conversations` / `ai_messages`** if cross-device history or an
  audit trail for AI actions matters. Given `task_events` already exists as
  an audit pattern for tasks, a parallel `ai_messages` table (with
  `workspace_id`, `user_id`, `role`, `content`, `created`, and — importantly
  — a `tool_calls`/`actions_taken` column so an AI-initiated task creation is
  traceable the same way a human one is) is a small, precedented addition.

**Recommendation: build the second option.** The existing action-execution
capability already changes data on a user's behalf; not recording that
anywhere is a bigger gap than the schema cost of one small table pair.

## 6. RAG / document search — deliberately out of scope for v1

Per the plan's own Phase 10: no vector search/embeddings in the first pass.
There's no existing document-chunking/embedding infrastructure to build on
(confirmed: no `pgvector` extension usage, no embedding calls anywhere in the
codebase), so this would be new infrastructure, not an extension of
something that exists — exactly the kind of scope the plan says to defer.
A future RAG pass would reasonably index: task/project descriptions, ticket
comments, and file attachments' extracted text — each already lives in
Postgres text columns today, so `pgvector` (a Postgres extension, no new
service to run) is the natural fit whenever that work is prioritized.

## 7. Railway / deployment

No separate AI service is justified. The existing backend already resolves
keys, calls Anthropic directly, and enforces workspace scoping in the same
process as every other route — splitting it out would add a network hop and
a second deploy target for no isolation benefit this app's traffic pattern
needs. Recommendation: keep the AI layer inside `app.py` (or, if `app.py`'s
size is being addressed separately per the architecture review's "Later"
lane — splitting it into blueprints — as its own blueprint module within the
same process).

## Next step

This is the plan. Tell me to proceed (or redirect any part of it) and Phase
4 onward — the tool refactor, native tool-use, the authorization fix, and
the conversation-history tables — gets built as a focused, incremental
change on top of what's here today, not a rewrite.
