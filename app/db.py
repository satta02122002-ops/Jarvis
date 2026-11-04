"""SQLite storage: conversations, tasks, memories, settings."""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,          -- JSON list of content blocks, exactly as sent to / received from the API
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due TEXT,                       -- ISO datetime in local (Dubai) time, optional
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
        _conn.execute("PRAGMA journal_mode = WAL")
        _conn.executescript(SCHEMA)
    return _conn


def reset_for_tests(path) -> None:
    global _conn
    _conn = None
    config.DB_PATH = path
    config.DATA_DIR = path.parent


def q(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def x(sql: str, params: tuple = ()) -> int:
    """Execute a write; returns lastrowid (or rowcount for updates/deletes)."""
    with _lock:
        c = conn()
        cur = c.execute(sql, params)
        c.commit()
        return cur.lastrowid if sql.lstrip().upper().startswith("INSERT") else cur.rowcount


# --- conversations ------------------------------------------------------------

def create_conversation(title: str = "New chat") -> int:
    ts = now_iso()
    return x("INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)", (title, ts, ts))


def list_conversations(limit: int = 30) -> list[dict]:
    return q("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?", (limit,))


def get_conversation(conv_id: int) -> dict | None:
    rows = q("SELECT * FROM conversations WHERE id = ?", (conv_id,))
    return rows[0] if rows else None


def rename_conversation(conv_id: int, title: str) -> None:
    x("UPDATE conversations SET title = ? WHERE id = ?", (title[:80], conv_id))


def delete_conversation(conv_id: int) -> None:
    x("DELETE FROM conversations WHERE id = ?", (conv_id,))


def append_message(conv_id: int, role: str, content: list[dict]) -> None:
    ts = now_iso()
    x(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (conv_id, role, json.dumps(content), ts),
    )
    x("UPDATE conversations SET updated_at = ? WHERE id = ?", (ts, conv_id))


def load_messages(conv_id: int) -> list[dict]:
    rows = q("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id", (conv_id,))
    return [{"role": r["role"], "content": json.loads(r["content"])} for r in rows]


# --- settings -----------------------------------------------------------------

def get_setting(key: str) -> str | None:
    rows = q("SELECT value FROM settings WHERE key = ?", (key,))
    return rows[0]["value"] if rows else None


def set_setting(key: str, value: str) -> None:
    x("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def delete_setting(key: str) -> None:
    x("DELETE FROM settings WHERE key = ?", (key,))
