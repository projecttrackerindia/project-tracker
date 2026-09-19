# Patch: BYOK + platform default AI ("Project Tracker AI")

## What this adds

Workspaces can now use AI features two ways:
1. **Their own Anthropic key** (Settings → AI Assistant) — unchanged, unlimited, billed to them.
2. **Your platform's shared default key** — new. Used automatically when a
   workspace hasn't set its own, capped per month per plan so no single
   workspace can run up your Anthropic bill.

Also fixed a pre-existing bug: `GET /api/usage` referenced a `PLAN_LIMITS`
variable that was never defined anywhere in the codebase and would have
raised `NameError` if that route was ever hit.

## Files changed

- **`ai_provider.py`** — new file. All key-resolution and quota logic lives
  here, isolated from `app.py`/`intelligence.py` so it's easy to read, test,
  or swap out later.
- **`app.py`** —
  - imports `ai_provider` near the top (guarded, same style as the existing
    `intelligence` import)
  - `_DEFAULT_WORKSPACE_PLAN_USAGE_LIMITS` gained an `ai_calls_platform_month`
    field per plan (50 / 200 / 1000 / 9999 for starter / team / business /
    enterprise)
  - `_limits_for_plan`'s custom-override whitelist now includes
    `ai_calls_platform_month`, so admins can raise a single workspace's cap
    the same way they already override other limits
  - `/api/ai/chat` and `/api/ai/generate-docs` now resolve the key via
    `ai_provider.resolve_ai_key()` instead of hard-requiring
    `workspaces.ai_api_key`, record usage, and return `ai_source` /
    `ai_platform_calls_used` / `ai_platform_calls_limit` in their JSON
  - `GET /api/usage` fixed to use the real `_limits_for_plan()` instead of
    the undefined `PLAN_LIMITS`, and now reports both total and
    platform-only AI call counts
  - the `register_intelligence(...)` call now passes `_record_usage` through
- **`intelligence.py`** —
  - `_workspace_ai_key()` replaced with `_resolve_ai()`, which uses the same
    fallback logic
  - all three AI features (allocation suggestions, ticket routing,
    follow-up drafting) use it and record usage on success
  - their three routes now handle a `LIMIT_EXCEEDED` error distinctly from
    `NO_KEY` / `NOT_CONFIGURED`, with a clear message either way
  - `register_intelligence()` gained a `record_usage=None` parameter
- **`README.md`** — added an "Environment Variables (Optional - for default/
  native AI)" section documenting `PLATFORM_AI_API_KEY`.

## No database migration needed

Everything reuses the existing `usage_events` table with two new
`event_type` values (`ai_call_total`, `ai_call_platform`) — no new tables or
columns.

## How to apply

1. Replace your `app.py` and `intelligence.py` with the versions in this
   patch (they're full-file drop-ins, not diffs to hand-apply).
2. Add `ai_provider.py` alongside them.
3. Merge the new README section, or just note it for reference.
4. In Railway → your app service (not a separate service — this modifies
   the existing Flask app) → **Variables**, add:
   ```
   PLATFORM_AI_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
   ```
   using your own Anthropic key. Leave it unset if you don't want a default
   AI yet — behavior is identical to before this patch in that case.
5. Redeploy.

## Testing checklist

- [ ] Workspace **with** its own key in Settings: AI chat still works,
      response includes `"ai_source": "own"`.
- [ ] Workspace **without** a key, `PLATFORM_AI_API_KEY` set: AI chat now
      works using the platform key, response includes
      `"ai_source": "platform"` and a `platform_calls_used` count that goes
      up by 1 each call.
- [ ] Same workspace after `platform_calls_used` reaches its plan's
      `ai_calls_platform_month` limit: next call returns
      `{"error": "LIMIT_EXCEEDED", ...}` with status 429, not a 500.
- [ ] `PLATFORM_AI_API_KEY` unset, workspace without its own key: same
      "please add your API key" message as before this patch.
- [ ] `GET /api/usage` returns without error and shows
      `ai_calls_month` / `ai_calls_platform_month`.
- [ ] `/api/intelligence/allocation/suggest`, the ticket routing endpoint,
      and the follow-up draft endpoint all behave the same way across the
      three scenarios above.
