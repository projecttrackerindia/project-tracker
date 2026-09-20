"""
ai_provider.py — decides which model backs a workspace's AI features
("Claude AI" or "Agent Tracker AI" in the UI), and enforces a monthly cap
on the shared option so one workspace can't monopolize it.

Priority order:
  1. The workspace's own key (workspaces.ai_api_key) — Anthropic's Claude,
     billed directly to Anthropic on the workspace owner's own account.
     This is "Claude AI" in the UI. Unlimited use here (it's their key,
     their bill).
  2. "Agent Tracker AI" — a self-hosted Ollama instance this platform runs
     (PLATFORM_OLLAMA_URL / PLATFORM_OLLAMA_MODEL env vars), so it carries
     no external API-key dependency and no per-call vendor cost. Still
     capped per workspace per calendar month, though the reason has
     shifted from "protect the Anthropic bill" to "protect shared compute
     capacity" - a CPU-only Ollama instance serves requests one at a time,
     so one workspace hammering it would starve everyone else's response
     times even though there's no dollar cost per call. Cap comes from the
     workspace's plan limits.

This module is intentionally dependency-free (no Flask, no app.py
globals) so it can be imported early and unit-tested on its own. The
caller passes in a plain `db` connection (same object app.py already
uses via get_db()) and the workspace's resolved AI-call limit.

Usage is recorded in the existing usage_events table:
  - event_type "ai_call_platform": one row per successful call that used
    the platform key. This is what the monthly cap counts against.
  - event_type "ai_call_total": one row per successful call regardless of
    which key was used, so /api/usage can show total AI usage.
"""
import os
import secrets
from datetime import datetime

# Where the self-hosted "Agent Tracker AI" model lives. Point this at an
# Ollama service reachable from this Railway service - e.g. another Railway
# service in the same project, addressed via Railway's private networking
# (something like http://ollama.railway.internal:11434), so it's never
# exposed to the public internet. Empty means "Agent Tracker AI" isn't
# configured yet and resolves to NOT_CONFIGURED, same as before this was
# wired up.
PLATFORM_OLLAMA_URL = os.environ.get("PLATFORM_OLLAMA_URL", "").strip().rstrip("/")
# A small instruct model is the right default for CPU-only serving - this
# is meant to be changed (bigger model, or a GPU-backed instance) once
# real compute is behind it. See README/deploy notes for model choices.
PLATFORM_OLLAMA_MODEL = os.environ.get("PLATFORM_OLLAMA_MODEL", "qwen2.5:3b-instruct").strip()

# Fallback cap used only if the caller doesn't pass an explicit limit
# (e.g. plan config lookup failed). Keep this conservative.
DEFAULT_PLATFORM_AI_CALL_LIMIT = 50


def _month_start_iso():
    return datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()


def _platform_calls_this_month(db, workspace_id):
    row = db.execute(
        "SELECT COALESCE(SUM(quantity), 0) as total FROM usage_events "
        "WHERE workspace_id=? AND event_type='ai_call_platform' AND created>=?",
        (workspace_id, _month_start_iso()),
    ).fetchone()
    return int(row["total"]) if row else 0


def resolve_ai_key(db, workspace_id, platform_call_limit=None, decrypt_fn=None, preferred_source=None):
    """
    Figures out which API key (if any) this workspace should use right now.

    `decrypt_fn`, if given, is called on the raw `ai_api_key` column value
    before use — pass app.py's `vault_decrypt` (bound to this workspace) so
    a workspace's own key, which is stored encrypted at rest, is usable
    here without this module needing to import app.py's crypto directly
    (keeps this module dependency-free / independently testable). Omitting
    it just uses the raw column value, which still works for legacy rows
    written before encryption-at-rest was added — vault_decrypt itself
    falls back to returning unencrypted values unchanged, so callers don't
    need to know which rows are encrypted and which aren't.

    `preferred_source` lets a caller override the default auto-pick
    ("own" key wins if set, else fall back to "platform"):
      - "platform": use the shared platform key even if the workspace has
        set its own — this is the "Agent Tracker AI" choice in the UI.
      - "own": use only the workspace's own key, and fail with
        OWN_KEY_NOT_CONFIGURED (rather than silently falling back to the
        platform key) if none is set — this is the "Claude AI" choice, and
        falling back silently would defeat the point of the user
        deliberately picking "use MY key".
      - None (default): unchanged auto behavior.

    Returns a dict:
      {
        "key": <Anthropic api key string, or the sentinel "ollama"> or None,
        "source": "own" | "platform" | "none",
        "error": None | "NOT_CONFIGURED" | "OWN_KEY_NOT_CONFIGURED" | "LIMIT_EXCEEDED",
        "platform_calls_used": int or None,
        "platform_calls_limit": int or None,
      }

    "own" and successful "platform" results have error=None. For "own",
    `key` is a real Anthropic key to send as x-api-key. For "platform",
    `key` is just the literal string "ollama" - a truthy sentinel, not a
    real credential - since the self-hosted model needs no API key at all;
    the caller should branch on `source` to decide whether to call
    Anthropic or the Ollama instance at PLATFORM_OLLAMA_URL, not treat
    `key` as usable against Anthropic in the "platform" case. Any other
    combination means: don't call either backend, surface the error.
    """
    ws = db.execute(
        "SELECT ai_api_key FROM workspaces WHERE id=?", (workspace_id,)
    ).fetchone()
    raw_key = ws["ai_api_key"] if ws and ws["ai_api_key"] else ""
    if raw_key and decrypt_fn:
        try:
            raw_key = decrypt_fn(raw_key)
        except Exception:
            pass  # fail closed to the raw value rather than crash key resolution
    own_key = (raw_key or "").strip()

    if own_key and preferred_source != "platform":
        return {
            "key": own_key,
            "source": "own",
            "error": None,
            "platform_calls_used": None,
            "platform_calls_limit": None,
        }

    if preferred_source == "own":
        return {
            "key": None,
            "source": "own",
            "error": "OWN_KEY_NOT_CONFIGURED",
            "platform_calls_used": None,
            "platform_calls_limit": None,
        }

    if not PLATFORM_OLLAMA_URL:
        return {
            "key": None,
            "source": "none",
            "error": "NOT_CONFIGURED",
            "platform_calls_used": 0,
            "platform_calls_limit": 0,
        }

    limit = platform_call_limit if platform_call_limit is not None else DEFAULT_PLATFORM_AI_CALL_LIMIT
    used = _platform_calls_this_month(db, workspace_id)

    if used >= limit:
        return {
            "key": None,
            "source": "platform",
            "error": "LIMIT_EXCEEDED",
            "platform_calls_used": used,
            "platform_calls_limit": limit,
        }

    return {
        "key": "ollama",  # sentinel - see resolve_ai_key's docstring
        "source": "platform",
        "error": None,
        "platform_calls_used": used,
        "platform_calls_limit": limit,
    }


def record_ai_call(record_usage_fn, workspace_id, source, meta=None):
    """
    Call this once, after a successful model call (Anthropic or the
    self-hosted Ollama instance). `record_usage_fn`
    should be app.py's existing `_record_usage(workspace_id, event_type,
    quantity, meta)` — passed in rather than imported to avoid a circular
    import between app.py and this module.
    """
    record_usage_fn(workspace_id, "ai_call_total", 1, meta)
    if source == "platform":
        record_usage_fn(workspace_id, "ai_call_platform", 1, meta)


def error_response_for(resolved):
    """
    Given a resolve_ai_key() result with an error, build the (dict, status)
    tuple app.py's routes already return via jsonify(...), <status>.
    """
    if resolved["error"] == "NOT_CONFIGURED":
        return (
            {
                "error": "NO_KEY",
                "message": (
                    "AI features aren't available yet. Add your own Anthropic API key in "
                    "Workspace Settings to use Claude AI, or ask your platform admin to finish "
                    "setting up Agent Tracker AI (PLATFORM_OLLAMA_URL isn't configured)."
                ),
            },
            400,
        )
    if resolved["error"] == "OWN_KEY_NOT_CONFIGURED":
        return (
            {
                "error": "OWN_KEY_NOT_CONFIGURED",
                "message": (
                    "You've selected Claude AI, but this workspace hasn't added an Anthropic API key yet. "
                    "Add one in Workspace Settings → AI Assistant, or switch to Agent Tracker AI to keep going "
                    "without your own key."
                ),
            },
            400,
        )
    if resolved["error"] == "LIMIT_EXCEEDED":
        return (
            {
                "error": "LIMIT_EXCEEDED",
                "message": (
                    f"This workspace has used all {resolved['platform_calls_limit']} free "
                    "AI calls from Agent Tracker AI this month. Add your own Anthropic API "
                    "key in Workspace Settings to switch to Claude AI, which has no monthly limit."
                ),
                "platform_calls_used": resolved["platform_calls_used"],
                "platform_calls_limit": resolved["platform_calls_limit"],
            },
            429,
        )
    # Shouldn't happen, but fail safe.
    return {"error": "NO_KEY", "message": "AI is not available right now."}, 400
