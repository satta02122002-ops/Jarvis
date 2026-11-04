"""Task & reminder tools."""

from datetime import datetime

from .. import config, db
from . import tool


def _parse_due(due: str | None) -> str | None:
    if not due:
        return None
    try:
        dt = datetime.fromisoformat(due)
    except ValueError as e:
        raise ValueError("due must be ISO 8601, e.g. 2026-11-05T09:00") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=config.TIMEZONE)
    return dt.astimezone(config.TIMEZONE).isoformat(timespec="minutes")


@tool(
    "add_task",
    "Add a task to the user's to-do list. Use for anything they need to do. "
    "To also get a phone notification at a specific time, additionally call calendar_create_event "
    "(if Google is connected).",
    {
        "title": {"type": "string", "description": "Short task title."},
        "notes": {"type": "string", "description": "Optional details."},
        "due": {"type": "string", "description": "Optional due date/time, ISO 8601 in Dubai local time, e.g. 2026-11-05T09:00."},
        "priority": {"type": "string", "enum": ["low", "normal", "high"]},
    },
    ["title"],
)
def add_task(title: str, notes: str = "", due: str | None = None, priority: str = "normal"):
    due_iso = _parse_due(due)
    task_id = db.x(
        "INSERT INTO tasks (title, notes, due, priority, created_at) VALUES (?, ?, ?, ?, ?)",
        (title.strip(), notes.strip(), due_iso, priority, db.now_iso()),
    )
    return {"ok": True, "task_id": task_id, "title": title, "due": due_iso, "priority": priority}


@tool(
    "list_tasks",
    "List the user's tasks. Default shows open tasks sorted by due date.",
    {"status": {"type": "string", "enum": ["open", "done", "all"]}},
)
def list_tasks(status: str = "open"):
    where = "" if status == "all" else "WHERE status = ?"
    params: tuple = () if status == "all" else (status,)
    rows = db.q(
        f"SELECT id, title, notes, due, priority, status, completed_at FROM tasks {where} "
        "ORDER BY status, due IS NULL, due, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id "
        "LIMIT 100",
        params,
    )
    return {"count": len(rows), "tasks": rows}


@tool(
    "update_task",
    "Edit a task, mark it done, or reopen it. Look up task_id with list_tasks first if unsure.",
    {
        "task_id": {"type": "integer"},
        "title": {"type": "string"},
        "notes": {"type": "string"},
        "due": {"type": "string", "description": "ISO 8601 Dubai time, or empty string to clear."},
        "priority": {"type": "string", "enum": ["low", "normal", "high"]},
        "status": {"type": "string", "enum": ["open", "done"]},
    },
    ["task_id"],
)
def update_task(task_id: int, **changes):
    if not db.q("SELECT id FROM tasks WHERE id = ?", (task_id,)):
        return {"ok": False, "error": f"No task with id {task_id}"}
    sets, params = [], []
    for field in ("title", "notes", "priority"):
        if changes.get(field) is not None:
            sets.append(f"{field} = ?")
            params.append(changes[field])
    if "due" in changes and changes["due"] is not None:
        sets.append("due = ?")
        params.append(_parse_due(changes["due"]))
    if changes.get("status"):
        sets.append("status = ?")
        params.append(changes["status"])
        sets.append("completed_at = ?")
        params.append(db.now_iso() if changes["status"] == "done" else None)
    if not sets:
        return {"ok": False, "error": "Nothing to change"}
    db.x(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", (*params, task_id))
    return {"ok": True, "task": db.q("SELECT * FROM tasks WHERE id = ?", (task_id,))[0]}


@tool(
    "delete_task",
    "Permanently delete a task (use update_task with status=done to complete it instead).",
    {"task_id": {"type": "integer"}},
    ["task_id"],
)
def delete_task(task_id: int):
    n = db.x("DELETE FROM tasks WHERE id = ?", (task_id,))
    return {"ok": bool(n), "deleted": n}


def open_task_summary() -> str:
    """Compact line used in the daily briefing context."""
    rows = list_tasks("open")["tasks"]
    if not rows:
        return "No open tasks."
    lines = [f"#{r['id']} {r['title']}" + (f" (due {r['due']})" if r["due"] else "") for r in rows[:15]]
    return "\n".join(lines)
