#!/usr/bin/env python3
"""
intelligence.py — Project Intelligence Layer for Project Tracker
==================================================================
Adds, on top of the existing schema (projects/tasks/tickets/users/time_logs):

  1. SMART RESOURCE ALLOCATION
     Computes real workload/availability per person from live task + time-log
     data, ranks projects by urgency (deadline proximity + progress gap +
     overdue task count), and asks Claude to propose which available person
     should pick up which pending task — with a written reason. Suggestions
     are stored PENDING until a manager approves or rejects them; nothing is
     auto-assigned.

  2. BUG / CR AUTO-ROUTING
     When a new ticket (bug/CR) comes in, finds the person most likely to
     have built the related feature — using task completion history in the
     same project plus Claude's read of the ticket text vs. past task titles
     /descriptions — and proposes routing it to them. Manager approves before
     the ticket is reassigned.

  3. COMMENT UNDERSTANDING + FOLLOW-UP DRAFTING
     Summarizes a ticket/task comment thread, identifies who currently owns
     the next action, and drafts a follow-up email addressed to them. The
     draft is stored and only sent when a human clicks "Send" — nothing goes
     out automatically.

  4. PRIORITY DASHBOARD
     One endpoint that rolls all of the above into a single "what needs
     attention right now" view, ordered by urgency.

Integration (already added to the bottom of app.py):

    from intelligence import register_intelligence
    register_intelligence(app, get_db, wid, login_required, session,
                           send_email, log, secrets, json, datetime, timedelta,
                           request, jsonify)

No existing table, route, or frontend file is modified. A minimal built-in
dashboard is served at GET /intelligence so this is usable immediately;
see INTEGRATION.md for the two small snippets to wire a "Send Follow-up"
button into your existing ticket/task views.
"""

import urllib.request
import urllib.error
import re as _re


# ─────────────────────────────────────────────────────────────────────────
# Wired in by register_intelligence()
# ─────────────────────────────────────────────────────────────────────────
_app = None
_get_db = None
_wid = None
_login_required = None
_session = None
_send_email = None
_log = None
_secrets = None
_json = None
_datetime = None
_timedelta = None
_request = None
_jsonify = None


# ─────────────────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────────────────
def _ensure_schema():
    with _get_db() as db:
        stmts = [
            """CREATE TABLE IF NOT EXISTS resource_skills (
                id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT,
                skill TEXT, level INTEGER DEFAULT 3, created TEXT)""",
            """CREATE TABLE IF NOT EXISTS allocation_suggestions (
                id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT,
                task_id TEXT, suggested_user_id TEXT, reason TEXT DEFAULT '',
                urgency_score REAL DEFAULT 0, status TEXT DEFAULT 'pending',
                created TEXT, decided_by TEXT DEFAULT '', decided_at TEXT DEFAULT '')""",
            """CREATE TABLE IF NOT EXISTS ticket_routing_suggestions (
                id TEXT PRIMARY KEY, workspace_id TEXT, ticket_id TEXT,
                suggested_user_id TEXT, confidence REAL DEFAULT 0, reason TEXT DEFAULT '',
                status TEXT DEFAULT 'pending', created TEXT,
                decided_by TEXT DEFAULT '', decided_at TEXT DEFAULT '')""",
            """CREATE TABLE IF NOT EXISTS followup_drafts (
                id TEXT PRIMARY KEY, workspace_id TEXT, entity_type TEXT, entity_id TEXT,
                to_user_id TEXT, subject TEXT DEFAULT '', body TEXT DEFAULT '',
                summary TEXT DEFAULT '', status TEXT DEFAULT 'draft',
                created TEXT, created_by TEXT DEFAULT '', sent_at TEXT DEFAULT '', sent_by TEXT DEFAULT '')""",
            "CREATE INDEX IF NOT EXISTS idx_alloc_sugg_ws ON allocation_suggestions(workspace_id, status)",
            "CREATE INDEX IF NOT EXISTS idx_route_sugg_ws ON ticket_routing_suggestions(workspace_id, status)",
            "CREATE INDEX IF NOT EXISTS idx_followup_ws ON followup_drafts(workspace_id, status)",
        ]
        for s in stmts:
            try:
                db.execute(s)
            except Exception as e:
                _log.warning("[intelligence] schema stmt skipped: %s", e)
        try:
            db.commit()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────
# Claude helper — reuses the same per-workspace key as the existing /api/ai/chat
# ─────────────────────────────────────────────────────────────────────────
def _workspace_ai_key(db):
    ws = db.execute("SELECT ai_api_key FROM workspaces WHERE id=?", (_wid(),)).fetchone()
    return (ws["ai_api_key"] if ws and ws["ai_api_key"] else "").strip()


def _call_claude(system, user_prompt, api_key, max_tokens=1200):
    """Returns (text, error). error is None on success."""
    if not api_key:
        return None, "NO_KEY"
    try:
        req_data = _json.dumps({
            "model": "claude-sonnet-4-5",
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user_prompt}],
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=req_data, method="POST",
            headers={"Content-Type": "application/json", "x-api-key": api_key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = _json.loads(resp.read().decode())
            return result["content"][0]["text"], None
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return None, "INVALID_KEY"
        return None, f"API_ERROR:{e.read().decode()[:200]}"
    except Exception as e:
        return None, f"NETWORK_ERROR:{e}"


def _extract_json(text):
    """Pull the first {...} or [...] block out of a Claude reply."""
    m = _re.search(r'(\{.*\}|\[.*\])', text, _re.DOTALL)
    if not m:
        return None
    try:
        return _json.loads(m.group(1))
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────
# 1. Resource availability + project urgency (pure computation, no AI)
# ─────────────────────────────────────────────────────────────────────────
def _compute_resource_load(db, workspace_id):
    """Per-user: open task count, story points committed, hours logged last 7d,
    whether currently on approved leave. Lower load_score = more available."""
    today = _datetime.now().date()
    week_ago = (today - _timedelta(days=7)).isoformat()

    users = db.execute("SELECT id,name,role,email FROM users WHERE workspace_id=?", (workspace_id,)).fetchall()
    tasks = db.execute(
        "SELECT assignee,priority,stage,story_points,due FROM tasks "
        "WHERE workspace_id=? AND stage NOT IN ('done','completed','cancelled') AND assignee!=''",
        (workspace_id,)).fetchall()
    hours = db.execute(
        "SELECT user_id, COALESCE(SUM(hours),0) h FROM time_logs "
        "WHERE workspace_id=? AND date>=? GROUP BY user_id",
        (workspace_id, week_ago)).fetchall()
    hours_by_user = {r["user_id"]: float(r["h"] or 0) for r in hours}

    on_leave_ids = set()
    try:
        leave_rows = db.execute(
            "SELECT user_id FROM leave_requests WHERE workspace_id=? AND status='approved' "
            "AND start_date<=? AND end_date>=?",
            (workspace_id, today.isoformat(), today.isoformat())).fetchall()
        on_leave_ids = {r["user_id"] for r in leave_rows}
    except Exception:
        pass  # table may not exist in older schemas

    load = {}
    for t in tasks:
        uid = t["assignee"]
        if not uid:
            continue
        entry = load.setdefault(uid, {"open_tasks": 0, "story_points": 0, "overdue": 0, "high_priority": 0})
        entry["open_tasks"] += 1
        entry["story_points"] += int(t["story_points"] or 0)
        if str(t["priority"]).lower() in ("high", "urgent", "critical"):
            entry["high_priority"] += 1
        if t["due"]:
            try:
                if _datetime.strptime(t["due"][:10], "%Y-%m-%d").date() < today:
                    entry["overdue"] += 1
            except Exception:
                pass

    result = []
    for u in users:
        uid = u["id"]
        L = load.get(uid, {"open_tasks": 0, "story_points": 0, "overdue": 0, "high_priority": 0})
        weekly_hours = hours_by_user.get(uid, 0.0)
        # Simple, transparent load score: task count + 0.5*points + 2*overdue - hours logged as a
        # very rough proxy for "actually engaged" vs "assigned but idle". Lower = freer.
        load_score = L["open_tasks"] + 0.5 * L["story_points"] + 2 * L["overdue"]
        result.append({
            "user_id": uid, "name": u["name"], "role": u["role"],
            "open_tasks": L["open_tasks"], "story_points": L["story_points"],
            "overdue_tasks": L["overdue"], "high_priority_tasks": L["high_priority"],
            "hours_last_7d": round(weekly_hours, 1),
            "on_leave_today": uid in on_leave_ids,
            "load_score": round(load_score, 1),
            "available": (uid not in on_leave_ids) and load_score < 12,
        })
    result.sort(key=lambda r: (r["on_leave_today"], r["load_score"]))
    return result


def _compute_project_urgency(db, workspace_id):
    projects = db.execute("SELECT id,name,target_date,progress FROM projects WHERE workspace_id=?", (workspace_id,)).fetchall()
    today = _datetime.now().date()
    out = []
    for p in projects:
        days_left = None
        if p["target_date"]:
            try:
                days_left = (_datetime.strptime(p["target_date"][:10], "%Y-%m-%d").date() - today).days
            except Exception:
                pass
        overdue_tasks = db.execute(
            "SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND project=? AND stage NOT IN ('done','completed','cancelled') "
            "AND due!='' AND due<?", (workspace_id, p["id"], today.isoformat())).fetchone()["c"]
        open_tasks = db.execute(
            "SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND project=? AND stage NOT IN ('done','completed','cancelled')",
            (workspace_id, p["id"])).fetchone()["c"]
        progress = p["progress"] or 0
        # urgency: closer deadline + more overdue + lower progress = higher score
        deadline_factor = 0
        if days_left is not None:
            deadline_factor = max(0, 30 - days_left) if days_left >= 0 else 30 + abs(days_left)
        urgency = deadline_factor + overdue_tasks * 5 + max(0, 70 - progress) * 0.3
        out.append({
            "project_id": p["id"], "name": p["name"], "days_left": days_left,
            "progress": progress, "overdue_tasks": overdue_tasks, "open_tasks": open_tasks,
            "urgency_score": round(urgency, 1),
        })
    out.sort(key=lambda r: -r["urgency_score"])
    return out


# ─────────────────────────────────────────────────────────────────────────
# 2. Allocation suggestions (AI-ranked, human-approved)
# ─────────────────────────────────────────────────────────────────────────
def _generate_allocation_suggestions(db, workspace_id, project_id=None, limit_tasks=8):
    urgency = _compute_project_urgency(db, workspace_id)
    if project_id:
        urgency = [u for u in urgency if u["project_id"] == project_id]
    resources = _compute_resource_load(db, workspace_id)
    available = [r for r in resources if r["available"]]

    if not urgency or not resources:
        return [], "No projects or team members found for this workspace yet."

    top_project_ids = [u["project_id"] for u in urgency[:5]]
    ph = ",".join(["?"] * len(top_project_ids)) if top_project_ids else "''"
    q = ("SELECT id,title,description,project,priority,due,story_points,labels FROM tasks "
         f"WHERE workspace_id=? AND assignee='' AND stage NOT IN ('done','completed','cancelled') "
         f"AND project IN ({ph}) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 "
         "WHEN 'medium' THEN 2 ELSE 3 END LIMIT ?")
    unassigned = db.execute(q, tuple([workspace_id] + top_project_ids + [limit_tasks])).fetchall() if top_project_ids else []

    if not unassigned:
        return [], "No unassigned pending tasks in your highest-urgency projects right now."

    api_key = _workspace_ai_key(db)
    if not api_key:
        return [], "NO_KEY"

    proj_ctx = "\n".join(f"- {u['name']} (id:{u['project_id']}) urgency:{u['urgency_score']} "
                          f"days_left:{u['days_left']} progress:{u['progress']}% overdue_tasks:{u['overdue_tasks']}"
                          for u in urgency[:5])
    task_ctx = "\n".join(f"- [{t['id']}] \"{t['title']}\" project:{t['project']} priority:{t['priority']} "
                          f"due:{t['due']} points:{t['story_points']} desc:{(t['description'] or '')[:200]}"
                          for t in unassigned)
    res_ctx = "\n".join(f"- {r['name']} (id:{r['user_id']}) role:{r['role']} open_tasks:{r['open_tasks']} "
                         f"overdue:{r['overdue_tasks']} hours_last_7d:{r['hours_last_7d']} load_score:{r['load_score']}"
                         for r in available)

    system = ("You are a resource-allocation assistant for a software project tracker. "
               "You NEVER assign anyone yourself — you only propose, and a manager approves. "
               "Weigh: project urgency, task priority/deadline, and who currently has the lowest "
               "load AND is not overloaded with overdue work. Prefer spreading load rather than "
               "piling onto the single freest person if several are close.")
    prompt = (f"PROJECTS BY URGENCY:\n{proj_ctx}\n\nUNASSIGNED PENDING TASKS:\n{task_ctx}\n\n"
              f"AVAILABLE TEAM MEMBERS:\n{res_ctx}\n\n"
              "Return ONLY a JSON array, one object per task you have a confident suggestion for "
              "(skip tasks with no good match), each: "
              '{"task_id":"...","user_id":"...","reason":"one or two sentences, specific and concrete"}')

    text, err = _call_claude(system, prompt, api_key, max_tokens=1500)
    if err:
        return [], err
    parsed = _extract_json(text) or []
    if not isinstance(parsed, list):
        return [], "AI_PARSE_ERROR"

    task_map = {t["id"]: t for t in unassigned}
    urgency_map = {u["project_id"]: u["urgency_score"] for u in urgency}
    created = []
    now = _datetime.now().isoformat()
    for item in parsed:
        tid, uid, reason = item.get("task_id"), item.get("user_id"), item.get("reason", "")
        t = task_map.get(tid)
        if not t or not uid:
            continue
        sid = "alloc" + _secrets.token_hex(8)
        db.execute(
            "INSERT INTO allocation_suggestions(id,workspace_id,project_id,task_id,suggested_user_id,reason,"
            "urgency_score,status,created) VALUES(?,?,?,?,?,?,?,?,?)",
            (sid, workspace_id, t["project"], tid, uid, reason,
             urgency_map.get(t["project"], 0), "pending", now))
        created.append({"id": sid, "task_id": tid, "task_title": t["title"], "project_id": t["project"],
                         "suggested_user_id": uid, "reason": reason,
                         "urgency_score": urgency_map.get(t["project"], 0)})
    db.commit()
    return created, None


# ─────────────────────────────────────────────────────────────────────────
# 3. Bug / CR routing
# ─────────────────────────────────────────────────────────────────────────
def _find_original_developer_candidates(db, workspace_id, ticket, limit=25):
    """Completed tasks in the same project, with whoever was assignee when
    it reached 'done' (from task_events), as candidate 'who built this'."""
    proj = ticket["project"]
    q = ("SELECT id,title,description,assignee FROM tasks WHERE workspace_id=? "
         "AND stage IN ('done','completed') " + ("AND project=? " if proj else "") +
         "ORDER BY created DESC LIMIT ?")
    params = [workspace_id] + ([proj] if proj else []) + [limit]
    tasks = db.execute(q, tuple(params)).fetchall()

    candidates = []
    for t in tasks:
        assignee = t["assignee"]
        if not assignee:
            # fall back to last assignee change recorded in task_events
            ev = db.execute(
                "SELECT new_val FROM task_events WHERE workspace_id=? AND task_id=? AND event_type='assignee' "
                "ORDER BY ts DESC LIMIT 1", (workspace_id, t["id"])).fetchone()
            assignee = ev["new_val"] if ev else ""
        if assignee:
            candidates.append({"task_id": t["id"], "title": t["title"],
                                "description": t["description"] or "", "assignee": assignee})
    return candidates


def _generate_routing_suggestion(db, workspace_id, ticket_id):
    ticket = db.execute("SELECT * FROM tickets WHERE workspace_id=? AND id=?", (workspace_id, ticket_id)).fetchone()
    if not ticket:
        return None, "NOT_FOUND"

    candidates = _find_original_developer_candidates(db, workspace_id, ticket)
    if not candidates:
        return None, "No completed tasks found to trace this back to — nothing to route against yet."

    api_key = _workspace_ai_key(db)
    if not api_key:
        return None, "NO_KEY"

    users = {u["id"]: u["name"] for u in db.execute("SELECT id,name FROM users WHERE workspace_id=?", (workspace_id,)).fetchall()}
    cand_ctx = "\n".join(f"- task[{c['task_id']}] \"{c['title']}\" (built by {users.get(c['assignee'], c['assignee'])}, "
                          f"id:{c['assignee']}): {c['description'][:200]}" for c in candidates)

    system = ("You trace bug reports and change requests back to the developer who most likely built "
              "the related feature, based on completed task titles/descriptions. You never guess wildly — "
              "if nothing is a plausible match, say so with low confidence.")
    prompt = (f"TICKET (type:{ticket['type']}, priority:{ticket['priority']}):\n"
              f"\"{ticket['title']}\"\n{(ticket['description'] or '')[:500]}\n\n"
              f"CANDIDATE COMPLETED TASKS:\n{cand_ctx}\n\n"
              "Return ONLY JSON: {\"user_id\":\"...\",\"task_id\":\"...\",\"confidence\":0.0-1.0,"
              "\"reason\":\"one or two sentences citing the specific matching task\"}")

    text, err = _call_claude(system, prompt, api_key, max_tokens=600)
    if err:
        return None, err
    parsed = _extract_json(text)
    if not parsed or not parsed.get("user_id"):
        return None, "AI_NO_MATCH"

    sid = "route" + _secrets.token_hex(8)
    now = _datetime.now().isoformat()
    db.execute(
        "INSERT INTO ticket_routing_suggestions(id,workspace_id,ticket_id,suggested_user_id,confidence,reason,status,created) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (sid, workspace_id, ticket_id, parsed["user_id"], float(parsed.get("confidence", 0.5)),
         parsed.get("reason", ""), "pending", now))
    db.commit()
    return {"id": sid, "ticket_id": ticket_id, "suggested_user_id": parsed["user_id"],
            "suggested_user_name": users.get(parsed["user_id"], ""),
            "confidence": parsed.get("confidence", 0.5), "reason": parsed.get("reason", ""),
            "matched_task_id": parsed.get("task_id")}, None


# ─────────────────────────────────────────────────────────────────────────
# 4. Comment understanding + follow-up drafting
# ─────────────────────────────────────────────────────────────────────────
def _gather_thread(db, workspace_id, entity_type, entity_id):
    users = {u["id"]: u for u in db.execute("SELECT id,name,email FROM users WHERE workspace_id=?", (workspace_id,)).fetchall()}
    if entity_type == "ticket":
        entity = db.execute("SELECT * FROM tickets WHERE workspace_id=? AND id=?", (workspace_id, entity_id)).fetchone()
        comments = db.execute("SELECT * FROM ticket_comments WHERE workspace_id=? AND ticket_id=? ORDER BY created ASC",
                               (workspace_id, entity_id)).fetchall()
        owner_id = entity["assignee"] if entity else None
        title = entity["title"] if entity else ""
    else:
        entity = db.execute("SELECT * FROM tasks WHERE workspace_id=? AND id=?", (workspace_id, entity_id)).fetchone()
        comments = []
        try:
            raw = _json.loads(entity["comments"]) if entity and entity["comments"] else []
            comments = [{"user_id": c.get("user") or c.get("user_id", ""), "content": c.get("text") or c.get("content", ""),
                         "created": c.get("ts") or c.get("created", "")} for c in raw]
        except Exception:
            pass
        owner_id = entity["assignee"] if entity else None
        title = entity["title"] if entity else ""
    return entity, comments, owner_id, title, users


def _summarize_and_draft_followup(db, workspace_id, entity_type, entity_id, to_user_id, created_by):
    entity, comments, owner_id, title, users = _gather_thread(db, workspace_id, entity_type, entity_id)
    if not entity:
        return None, "NOT_FOUND"

    target_id = to_user_id or owner_id
    if not target_id:
        return None, "No owner/assignee to follow up with on this item."
    target = users.get(target_id)
    if not target:
        return None, "Target user not found in this workspace."

    api_key = _workspace_ai_key(db)
    if not api_key:
        return None, "NO_KEY"

    # Normalize both DB Row objects (ticket_comments) and plain dicts (task
    # comments parsed from JSON) into a uniform (user_id, created, content) tuple.
    def _unpack(c):
        if isinstance(c, dict):
            return c.get("user_id", ""), c.get("created", ""), c.get("content", "")
        return c["user_id"], c["created"], c["content"]

    lines = []
    for c in comments:
        uid_c, created_c, content_c = _unpack(c)
        author = users.get(uid_c)
        author_name = author["name"] if author else "Unknown"
        lines.append(f"- {author_name} ({created_c}): {content_c or ''}")
    thread_ctx = "\n".join(lines) or "(no comments yet)"

    system = ("You write short, specific, professional follow-up emails for a project tracker. "
               "Reference concrete open points from the thread — never generic filler like "
               "'just checking in'. Keep it to 3-5 sentences. This is a DRAFT a human will review "
               "before sending, so it's fine to be direct.")
    prompt = (f"ITEM: \"{title}\" (type:{entity_type})\nRECIPIENT: {target['name']}\n\n"
              f"COMMENT THREAD:\n{thread_ctx}\n\n"
              "Return ONLY JSON: {\"summary\":\"1-2 sentence internal summary of thread status\","
              "\"subject\":\"email subject\",\"body\":\"plain-text email body addressed to the recipient by first name, "
              "referencing specific open points, asking for a concrete status update or next step\"}")

    text, err = _call_claude(system, prompt, api_key, max_tokens=700)
    if err:
        return None, err
    parsed = _extract_json(text)
    if not parsed:
        return None, "AI_PARSE_ERROR"

    did = "fu" + _secrets.token_hex(8)
    now = _datetime.now().isoformat()
    db.execute(
        "INSERT INTO followup_drafts(id,workspace_id,entity_type,entity_id,to_user_id,subject,body,summary,status,created,created_by) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (did, workspace_id, entity_type, entity_id, target_id, parsed.get("subject", f"Follow-up: {title}"),
         parsed.get("body", ""), parsed.get("summary", ""), "draft", now, created_by))
    db.commit()
    return {"id": did, "entity_type": entity_type, "entity_id": entity_id, "to_user_id": target_id,
            "to_user_name": target["name"], "to_user_email": target["email"],
            "subject": parsed.get("subject"), "body": parsed.get("body"), "summary": parsed.get("summary")}, None


# ─────────────────────────────────────────────────────────────────────────
# Route registration
# ─────────────────────────────────────────────────────────────────────────
def register_intelligence(app, get_db, wid, login_required, session, send_email, log,
                           secrets, json, datetime, timedelta, request, jsonify):
    global _app, _get_db, _wid, _login_required, _session, _send_email, _log
    global _secrets, _json, _datetime, _timedelta, _request, _jsonify
    _app, _get_db, _wid, _login_required, _session = app, get_db, wid, login_required, session
    _send_email, _log = send_email, log
    _secrets, _json, _datetime, _timedelta = secrets, json, datetime, timedelta
    _request, _jsonify = request, jsonify

    try:
        _ensure_schema()
    except Exception as e:
        log.error("[intelligence] schema init failed: %s", e)

    # ---- Dashboard: resources + urgency + pending suggestions, one call ----
    @app.route("/api/intelligence/dashboard", methods=["GET"])
    @login_required
    def intel_dashboard():
        with get_db() as db:
            resources = _compute_resource_load(db, wid())
            urgency = _compute_project_urgency(db, wid())
            pending_alloc = db.execute(
                "SELECT a.*,t.title task_title,u.name suggested_name FROM allocation_suggestions a "
                "LEFT JOIN tasks t ON t.id=a.task_id LEFT JOIN users u ON u.id=a.suggested_user_id "
                "WHERE a.workspace_id=? AND a.status='pending' ORDER BY a.urgency_score DESC LIMIT 50",
                (wid(),)).fetchall()
            pending_routes = db.execute(
                "SELECT r.*,tk.title ticket_title,u.name suggested_name FROM ticket_routing_suggestions r "
                "LEFT JOIN tickets tk ON tk.id=r.ticket_id LEFT JOIN users u ON u.id=r.suggested_user_id "
                "WHERE r.workspace_id=? AND r.status='pending' ORDER BY r.created DESC LIMIT 50",
                (wid(),)).fetchall()
            pending_followups = db.execute(
                "SELECT f.*,u.name to_name FROM followup_drafts f LEFT JOIN users u ON u.id=f.to_user_id "
                "WHERE f.workspace_id=? AND f.status='draft' ORDER BY f.created DESC LIMIT 50",
                (wid(),)).fetchall()
        return jsonify({
            "ok": True,
            "resources": resources,
            "project_urgency": urgency,
            "pending_allocations": [dict(r) for r in pending_alloc],
            "pending_routings": [dict(r) for r in pending_routes],
            "pending_followups": [dict(r) for r in pending_followups],
        })

    # ---- 1. Resource allocation ----
    @app.route("/api/intelligence/allocation/suggest", methods=["POST"])
    @login_required
    def intel_allocation_suggest():
        d = request.json or {}
        with get_db() as db:
            created, err = _generate_allocation_suggestions(db, wid(), project_id=d.get("project_id"))
        if err == "NO_KEY":
            return jsonify({"error": "NO_KEY", "message": "Add your Anthropic API key in Workspace Settings to enable AI suggestions."}), 400
        if err:
            return jsonify({"ok": True, "suggestions": [], "message": err})
        return jsonify({"ok": True, "suggestions": created})

    @app.route("/api/intelligence/allocation/<sid>/approve", methods=["POST"])
    @login_required
    def intel_allocation_approve(sid):
        with get_db() as db:
            s = db.execute("SELECT * FROM allocation_suggestions WHERE workspace_id=? AND id=?", (wid(), sid)).fetchone()
            if not s:
                return jsonify({"error": "not found"}), 404
            db.execute("UPDATE tasks SET assignee=? WHERE workspace_id=? AND id=?", (s["suggested_user_id"], wid(), s["task_id"]))
            now = datetime.now().isoformat()
            db.execute("UPDATE allocation_suggestions SET status='approved',decided_by=?,decided_at=? WHERE id=?",
                       (session.get("user_id"), now, sid))
            db.execute("INSERT INTO task_events(id,workspace_id,task_id,user_id,event_type,old_val,new_val,ts) VALUES(?,?,?,?,?,?,?,?)",
                       ("ev" + secrets.token_hex(8), wid(), s["task_id"], session.get("user_id"), "assignee", "", s["suggested_user_id"], now))
            db.commit()
        return jsonify({"ok": True})

    @app.route("/api/intelligence/allocation/<sid>/reject", methods=["POST"])
    @login_required
    def intel_allocation_reject(sid):
        with get_db() as db:
            db.execute("UPDATE allocation_suggestions SET status='rejected',decided_by=?,decided_at=? WHERE workspace_id=? AND id=?",
                       (session.get("user_id"), datetime.now().isoformat(), wid(), sid))
            db.commit()
        return jsonify({"ok": True})

    # ---- 2. Bug/CR routing ----
    @app.route("/api/intelligence/tickets/<ticket_id>/route-suggestion", methods=["POST"])
    @login_required
    def intel_route_suggest(ticket_id):
        with get_db() as db:
            result, err = _generate_routing_suggestion(db, wid(), ticket_id)
        if err == "NO_KEY":
            return jsonify({"error": "NO_KEY", "message": "Add your Anthropic API key in Workspace Settings to enable AI routing."}), 400
        if err:
            return jsonify({"ok": True, "suggestion": None, "message": err})
        return jsonify({"ok": True, "suggestion": result})

    @app.route("/api/intelligence/routing/<sid>/approve", methods=["POST"])
    @login_required
    def intel_route_approve(sid):
        with get_db() as db:
            s = db.execute("SELECT * FROM ticket_routing_suggestions WHERE workspace_id=? AND id=?", (wid(), sid)).fetchone()
            if not s:
                return jsonify({"error": "not found"}), 404
            db.execute("UPDATE tickets SET assignee=?,updated=? WHERE workspace_id=? AND id=?",
                       (s["suggested_user_id"], datetime.now().isoformat(), wid(), s["ticket_id"]))
            db.execute("UPDATE ticket_routing_suggestions SET status='approved',decided_by=?,decided_at=? WHERE id=?",
                       (session.get("user_id"), datetime.now().isoformat(), sid))
            db.commit()
        return jsonify({"ok": True})

    @app.route("/api/intelligence/routing/<sid>/reject", methods=["POST"])
    @login_required
    def intel_route_reject(sid):
        with get_db() as db:
            db.execute("UPDATE ticket_routing_suggestions SET status='rejected',decided_by=?,decided_at=? WHERE workspace_id=? AND id=?",
                       (session.get("user_id"), datetime.now().isoformat(), wid(), sid))
            db.commit()
        return jsonify({"ok": True})

    # ---- 3. Comment understanding + follow-up drafting ----
    @app.route("/api/intelligence/followup/draft", methods=["POST"])
    @login_required
    def intel_followup_draft():
        d = request.json or {}
        entity_type = d.get("entity_type")  # "ticket" | "task"
        entity_id = d.get("entity_id")
        to_user_id = d.get("to_user_id")  # optional override; defaults to assignee
        if entity_type not in ("ticket", "task") or not entity_id:
            return jsonify({"error": "entity_type must be 'ticket' or 'task', entity_id required"}), 400
        with get_db() as db:
            result, err = _summarize_and_draft_followup(db, wid(), entity_type, entity_id, to_user_id, session.get("user_id"))
        if err == "NO_KEY":
            return jsonify({"error": "NO_KEY", "message": "Add your Anthropic API key in Workspace Settings to enable AI drafting."}), 400
        if err:
            return jsonify({"error": "DRAFT_FAILED", "message": err}), 400
        return jsonify({"ok": True, "draft": result})

    @app.route("/api/intelligence/followup/<did>/send", methods=["POST"])
    @login_required
    def intel_followup_send(did):
        with get_db() as db:
            f = db.execute("SELECT * FROM followup_drafts WHERE workspace_id=? AND id=?", (wid(), did)).fetchone()
            if not f:
                return jsonify({"error": "not found"}), 404
            u = db.execute("SELECT email,name FROM users WHERE id=?", (f["to_user_id"],)).fetchone()
            if not u or not u["email"]:
                return jsonify({"error": "recipient has no email on file"}), 400
            body_html = "<p>" + f["body"].replace("\n\n", "</p><p>").replace("\n", "<br>") + "</p>"
            try:
                send_email(u["email"], f["subject"], body_html, workspace_id=wid())
            except Exception as e:
                return jsonify({"error": "SEND_FAILED", "message": str(e)}), 500
            db.execute("UPDATE followup_drafts SET status='sent',sent_at=?,sent_by=? WHERE id=?",
                       (datetime.now().isoformat(), session.get("user_id"), did))
            db.commit()
        return jsonify({"ok": True})

    @app.route("/api/intelligence/followup/<did>", methods=["GET"])
    @login_required
    def intel_followup_get(did):
        with get_db() as db:
            f = db.execute("SELECT * FROM followup_drafts WHERE workspace_id=? AND id=?", (wid(), did)).fetchone()
        if not f:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True, "draft": dict(f)})

    # ---- Minimal built-in dashboard page ----
    @app.route("/intelligence", methods=["GET"])
    @login_required
    def intel_page():
        return _DASHBOARD_HTML

    log.info("[intelligence] registered — dashboard at /intelligence")


_DASHBOARD_HTML = """<!doctype html><html><head><meta charset="utf-8">
<title>Project Intelligence</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1220;--card:#171b2e;--line:#262c47;--text:#e8eaf6;--muted:#8b91b8;--accent:#5a8cff;--good:#3ecf8e;--warn:#f5a623;--bad:#ef5b5b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
button.bad{background:var(--bad)}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);gap:8px}
.row:last-child{border-bottom:0}
.pill{font-size:11px;padding:2px 8px;border-radius:20px;background:#232849}
.pill.good{color:var(--good)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}
.muted{color:var(--muted);font-size:12px}
.empty{color:var(--muted);font-size:12px;padding:12px 0}
textarea{width:100%;background:#0f1220;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px}
</style></head><body><div class="wrap">
<h1>Project Intelligence</h1>
<p class="sub">Suggestions only — nothing here assigns or sends anything without your click.</p>

<div class="card">
  <h2>Urgency &amp; Allocation
    <button id="btnAlloc">Suggest allocations</button>
  </h2>
  <div id="urgency"></div>
  <div id="allocList"></div>
</div>

<div class="grid">
  <div class="card">
    <h2>Team Load</h2>
    <div id="resources"></div>
  </div>
  <div class="card">
    <h2>Pending Bug/CR Routing</h2>
    <div id="routing"></div>
  </div>
</div>

<div class="card">
  <h2>Follow-up Drafts</h2>
  <div id="followups"></div>
</div>

</div>
<script>
async function api(path, opts){const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opts||{}));return r.json();}

function pillFor(score){if(score>40)return 'bad';if(score>15)return 'warn';return 'good';}

async function load(){
  const d = await api('/api/intelligence/dashboard');
  const u = document.getElementById('urgency');
  u.innerHTML = d.project_urgency.map(p=>`<div class="row">
    <div><b>${p.name}</b> <span class="muted">${p.progress}% done · ${p.open_tasks} open · ${p.overdue_tasks} overdue</span></div>
    <span class="pill ${pillFor(p.urgency_score)}">urgency ${p.urgency_score}</span></div>`).join('') || '<div class="empty">No projects yet.</div>';

  const r = document.getElementById('resources');
  r.innerHTML = d.resources.map(x=>`<div class="row">
    <div><b>${x.name}</b> <span class="muted">${x.role||''}</span></div>
    <span class="pill ${x.on_leave_today?'bad':(x.available?'good':'warn')}">${x.on_leave_today?'on leave':(x.available?'available':'loaded')} · ${x.open_tasks} tasks</span></div>`).join('') || '<div class="empty">No team members yet.</div>';

  const al = document.getElementById('allocList');
  al.innerHTML = d.pending_allocations.map(a=>`<div class="row">
    <div><b>${a.task_title||a.task_id}</b><br><span class="muted">${a.reason||''}</span><br>
    <span class="muted">→ suggest: ${a.suggested_name||a.suggested_user_id}</span></div>
    <div><button onclick="decide('allocation','${a.id}','approve')">Approve</button>
    <button class="ghost" onclick="decide('allocation','${a.id}','reject')">Reject</button></div></div>`).join('') || '<div class="empty">No pending allocation suggestions. Click "Suggest allocations".</div>';

  const rt = document.getElementById('routing');
  rt.innerHTML = d.pending_routings.map(x=>`<div class="row">
    <div><b>${x.ticket_title||x.ticket_id}</b><br><span class="muted">${x.reason||''}</span><br>
    <span class="muted">→ suggest: ${x.suggested_name||x.suggested_user_id} (conf ${Math.round((x.confidence||0)*100)}%)</span></div>
    <div><button onclick="decide('routing','${x.id}','approve')">Approve</button>
    <button class="ghost" onclick="decide('routing','${x.id}','reject')">Reject</button></div></div>`).join('') || '<div class="empty">No pending routing suggestions yet — trigger one from a ticket.</div>';

  const fu = document.getElementById('followups');
  fu.innerHTML = d.pending_followups.map(f=>`<div class="row" style="flex-direction:column;align-items:stretch">
    <div><b>${f.subject}</b> <span class="muted">→ ${f.to_name||f.to_user_id}</span></div>
    <textarea rows="3" readonly>${f.body}</textarea>
    <div style="margin-top:6px"><button onclick="sendFollowup('${f.id}')">Send Follow-up</button></div></div>`).join('') || '<div class="empty">No drafts yet.</div>';
}

async function decide(kind, id, action){
  const path = kind==='allocation' ? `/api/intelligence/allocation/${id}/${action}` : `/api/intelligence/routing/${id}/${action}`;
  await api(path, {method:'POST'});
  load();
}
async function sendFollowup(id){
  const res = await api(`/api/intelligence/followup/${id}/send`, {method:'POST'});
  if(res.error){alert(res.message||res.error);return;}
  load();
}
document.getElementById('btnAlloc').onclick = async ()=>{
  const res = await api('/api/intelligence/allocation/suggest', {method:'POST', body: JSON.stringify({})});
  if(res.error==='NO_KEY'){alert(res.message);return;}
  load();
};
load();
</script></body></html>"""
