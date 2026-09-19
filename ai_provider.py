"""
ai_provider.py — decides which Anthropic API key to use for a workspace's
AI features, and enforces a monthly cap when falling back to the
platform's shared default key ("Project Tracker AI" / native AI).

Priority order:
  1. The workspace's own key (workspaces.ai_api_key) — unlimited use here,
     billed directly to Anthropic on the workspace owner's account.
  2. The platform's shared default key (PLATFORM_AI_API_KEY env var) —
     capped per workspace per calendar month so one workspace can't run up
     your Anthropic bill. Cap comes from the workspace's plan limits.

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

# Set this on the Railway service running app.py (NOT the same key you'd
# give an individual workspace) — this is Project Tracker's own Anthropic
# key, used as the default "native AI" for workspaces that haven't set
# their own.
PLATFORM_AI_API_KEY = os.environ.get("PLATFORM_AI_API_KEY", "").strip()

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


def resolve_ai_key(db, workspace_id, platform_call_limit=None, decrypt_fn=None):
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

    Returns a dict:
      {
        "key": <api key string> or None,
        "source": "own" | "platform" | "none",
        "error": None | "NOT_CONFIGURED" | "LIMIT_EXCEEDED",
        "platform_calls_used": int or None,
        "platform_calls_limit": int or None,
      }

    "own" and successful "platform" results have error=None and a usable key.
    Any other combination means: don't call Anthropic, surface the error.
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

    if own_key:
        return {
            "key": own_key,
            "source": "own",
            "error": None,
            "platform_calls_used": None,
            "platform_calls_limit": None,
        }

    if not PLATFORM_AI_API_KEY:
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
        "key": PLATFORM_AI_API_KEY,
        "source": "platform",
        "error": None,
        "platform_calls_used": used,
        "platform_calls_limit": limit,
    }


def record_ai_call(record_usage_fn, workspace_id, source, meta=None):
    """
    Call this once, after a successful Anthropic call. `record_usage_fn`
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
                    "Workspace Settings, or ask your platform admin to enable the default AI."
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
                    "AI calls from Project Tracker AI this month. Add your own Anthropic API "
                    "key in Workspace Settings to keep using AI features without a limit."
                ),
                "platform_calls_used": resolved["platform_calls_used"],
                "platform_calls_limit": resolved["platform_calls_limit"],
            },
            429,
        )
    # Shouldn't happen, but fail safe.
    return {"error": "NO_KEY", "message": "AI is not available right now."}, 400
