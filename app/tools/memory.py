"""Long-term memory: facts Jarvis remembers about the user across chats."""

from .. import db
from . import tool

MAX_IN_PROMPT = 200


@tool(
    "remember",
    "Save a durable fact about the user (preferences, people, projects, goals, routines, work details) "
    "so you remember it in future chats. Save only things worth knowing later; one fact per call. "
    "Do not save passwords, card numbers, or other secrets.",
    {
        "fact": {"type": "string", "description": "The fact, written as a standalone sentence."},
        "category": {"type": "string", "enum": ["personal", "work", "preference", "people", "project", "goal", "general"]},
    },
    ["fact"],
)
def remember(fact: str, category: str = "general"):
    fact = fact.strip()
    dup = db.q("SELECT id FROM memories WHERE lower(fact) = lower(?)", (fact,))
    if dup:
        return {"ok": True, "memory_id": dup[0]["id"], "note": "Already remembered."}
    mem_id = db.x("INSERT INTO memories (fact, category, created_at) VALUES (?, ?, ?)", (fact, category, db.now_iso()))
    return {"ok": True, "memory_id": mem_id}


@tool(
    "forget",
    "Delete a remembered fact by its id (ids are shown in your memory list). Use when a fact is wrong or the user asks.",
    {"memory_id": {"type": "integer"}},
    ["memory_id"],
)
def forget(memory_id: int):
    n = db.x("DELETE FROM memories WHERE id = ?", (memory_id,))
    return {"ok": bool(n)}


def all_memories() -> list[dict]:
    return db.q("SELECT id, fact, category FROM memories ORDER BY category, id LIMIT ?", (MAX_IN_PROMPT,))


def memory_block() -> str:
    rows = all_memories()
    if not rows:
        return "(nothing saved yet)"
    return "\n".join(f"[{r['id']}] ({r['category']}) {r['fact']}" for r in rows)
