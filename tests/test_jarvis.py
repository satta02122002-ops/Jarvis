"""Offline tests: tools, auth, and the agent loop with a fake Claude client (no API key needed)."""

import asyncio
import json
import os

os.environ.setdefault("JARVIS_DEV", "1")
os.environ.setdefault("APP_PASSWORD", "test-pass")
os.environ.setdefault("SECRET_KEY", "test-secret")

import pytest
from anthropic.types.beta import BetaMessage

from app import brain, config, db, tools


@pytest.fixture(autouse=True)
def fresh_db(tmp_path):
    db.reset_for_tests(tmp_path / "jarvis.db")
    yield


def run(coro):
    return asyncio.run(coro)


# --- tools ----------------------------------------------------------------------

def test_task_lifecycle():
    out, err = run(tools.execute("add_task", {"title": "Submit BOE on Mirsal 2", "due": "2026-11-05T09:00", "priority": "high"}))
    assert not err
    task = json.loads(out)
    assert task["due"].startswith("2026-11-05T09:00+04:00")

    out, _ = run(tools.execute("list_tasks", {}))
    assert json.loads(out)["count"] == 1

    out, err = run(tools.execute("update_task", {"task_id": task["task_id"], "status": "done"}))
    assert not err and json.loads(out)["task"]["status"] == "done"
    assert json.loads(run(tools.execute("list_tasks", {}))[0])["count"] == 0


def test_invalid_tool_input_is_reported_not_raised():
    out, err = run(tools.execute("add_task", {}))
    assert err and "title" in out
    out, err = run(tools.execute("add_task", {"title": "x", "priority": "urgent"}))
    assert err and "priority" in out
    out, err = run(tools.execute("add_task", {"title": "x", "due": "tomorrow-ish"}))
    assert err and "ISO" in out
    out, err = run(tools.execute("nope", {}))
    assert err


def test_memory_dedup_and_forget():
    a = json.loads(run(tools.execute("remember", {"fact": "Prefers tea over coffee", "category": "preference"}))[0])
    b = json.loads(run(tools.execute("remember", {"fact": "prefers tea over coffee"}))[0])
    assert a["memory_id"] == b["memory_id"]
    assert "Prefers tea" in tools.memory.memory_block()
    run(tools.execute("forget", {"memory_id": a["memory_id"]}))
    assert "nothing saved" in tools.memory.memory_block()


def test_google_tools_without_connection():
    out, err = run(tools.execute("gmail_search", {"query": "is:unread"}))
    assert not err and "not connected" in out


def test_tool_definitions_are_stable_and_valid():
    defs = tools.definitions()
    assert [d["name"] for d in defs] == sorted(d["name"] for d in defs)
    for d in defs:
        assert d["input_schema"]["additionalProperties"] is False
        assert set(d["input_schema"]["required"]) <= set(d["input_schema"]["properties"])


# --- agent loop with a fake client ------------------------------------------------

def _msg(content, stop_reason):
    return BetaMessage.model_validate({
        "id": "msg_x", "type": "message", "role": "assistant", "model": config.MODEL,
        "content": content, "stop_reason": stop_reason, "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 1},
    })


class FakeStream:
    def __init__(self, message):
        self.message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        async def gen():
            for block in self.message.content:
                if block.type == "text":
                    yield type("E", (), {"type": "content_block_delta", "delta": type("D", (), {"type": "text_delta", "text": block.text})()})()
        return gen()

    async def get_final_message(self):
        return self.message


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        outer = self

        class Msgs:
            def stream(self, **kw):
                outer.calls.append({**kw, "messages": list(kw["messages"])})
                return FakeStream(outer.responses.pop(0))

        self.beta = type("B", (), {"messages": Msgs()})()


def test_agent_loop_runs_tool_and_persists_history(monkeypatch):
    fake = FakeClient([
        _msg([{"type": "tool_use", "id": "toolu_1", "name": "add_task", "input": {"title": "Call Maersk"}}], "tool_use"),
        _msg([{"type": "text", "text": "Done. Added **Call Maersk**."}], "end_turn"),
    ])
    monkeypatch.setattr(brain, "_client", fake)
    conv = db.create_conversation()

    async def collect():
        return [c async for c in brain.run_turn(conv, "remind me to call Maersk")]

    chunks = "".join(run(collect()))
    assert "Added **Call Maersk**" in chunks and "event: refresh" in chunks and "event: done" in chunks

    # Tool actually ran.
    assert db.q("SELECT title FROM tasks")[0]["title"] == "Call Maersk"
    # History alternates and the second call carried the tool result.
    roles = [m["role"] for m in db.load_messages(conv)]
    assert roles == ["user", "assistant", "user", "assistant"]
    second = fake.calls[1]["messages"]
    assert second[-1]["content"][0]["type"] == "tool_result"
    # Request shape.
    first = fake.calls[0]
    assert first["model"] == config.MODEL and first["thinking"] == {"type": "adaptive"}
    assert first["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in first["betas"]
    assert any(t.get("type") == "web_search_20260209" for t in first["tools"])
    # UI view hides tool turns and the timestamp prefix.
    view = brain.display_messages(conv)
    assert view[0] == {"role": "user", "text": "remind me to call Maersk"}
    assert view[-1]["role"] == "assistant"


def test_refusal_keeps_history_valid(monkeypatch):
    monkeypatch.setattr(brain, "_client", FakeClient([_msg([], "refusal")]))
    conv = db.create_conversation()

    async def collect():
        return [c async for c in brain.run_turn(conv, "hi")]

    out = "".join(run(collect()))
    assert "event: error" in out
    assert [m["role"] for m in db.load_messages(conv)] == ["user", "assistant"]


# --- HTTP auth ----------------------------------------------------------------------

def test_login_required(monkeypatch):
    from fastapi.testclient import TestClient
    from app import main

    monkeypatch.setattr(config, "APP_PASSWORD", "test-pass")
    c = TestClient(main.app)
    assert c.get("/api/tasks").status_code == 401
    assert c.get("/api/status").json() == {"authed": False}
    assert c.post("/api/login", json={"password": "wrong"}).status_code == 401
    assert c.post("/api/login", json={"password": "test-pass"}).status_code == 200
    assert c.get("/api/tasks").status_code == 200
    assert c.get("/api/status").json()["authed"] is True
