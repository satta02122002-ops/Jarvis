/** Runs inside the Workers runtime with a local D1 database. Claude is replaced by a fake client. */
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayMessages, makeClient, runTurn, setClientFactory } from "../src/brain";
import * as db from "../src/db";
import type { Env } from "../src/env";
import { b64urlDecode, bodyText, buildRawEmail } from "../src/tools/google";
import { memoryBlock } from "../src/tools/memory";
import { definitions, execute } from "../src/tools/registry";
import { parseDue } from "../src/tools/tasks";

const E = env as unknown as Env;
const ctx = { env: E };
const parse = (r: { text: string }) => JSON.parse(r.text);
const realFactory = makeClient;
afterEach(() => setClientFactory(realFactory));
beforeEach(async () => {
  await E.DB.batch(["messages", "conversations", "tasks", "memories", "settings"].map((t) => E.DB.prepare(`DELETE FROM ${t}`)));
});

// --- tools ------------------------------------------------------------------------

describe("tasks", () => {
  it("adds, lists, completes", async () => {
    const added = parse(await execute("add_task", { title: "Submit BOE on Mirsal 2", due: "2026-11-05T09:00", priority: "high" }, ctx));
    expect(added.due).toBe("2026-11-05T09:00+04:00");
    expect(parse(await execute("list_tasks", {}, ctx)).count).toBe(1);
    const done = parse(await execute("update_task", { task_id: added.task_id, status: "done" }, ctx));
    expect(done.task.status).toBe("done");
    expect(parse(await execute("list_tasks", {}, ctx)).count).toBe(0);
  });

  it("parses due dates in Dubai time", () => {
    expect(parseDue("2026-11-05")).toBe("2026-11-05T09:00+04:00");
    expect(parseDue("2026-11-05T05:00Z")).toBe("2026-11-05T09:00+04:00");
    expect(parseDue("2026-11-05 23:30")).toBe("2026-11-05T23:30+04:00");
    expect(parseDue("")).toBeNull();
    expect(() => parseDue("tomorrow-ish")).toThrow(/ISO/);
  });

  it("reports invalid input instead of throwing", async () => {
    expect(await execute("add_task", {}, ctx)).toMatchObject({ isError: true });
    expect((await execute("add_task", { title: "x", priority: "urgent" }, ctx)).text).toMatch(/priority/);
    expect((await execute("add_task", { title: "x", bogus: 1 }, ctx)).text).toMatch(/Unknown field/);
    expect((await execute("update_task", { task_id: "7" }, ctx)).text).toMatch(/integer/);
    expect(await execute("nope", {}, ctx)).toMatchObject({ isError: true });
  });
});

describe("memory", () => {
  it("dedupes and forgets", async () => {
    const a = parse(await execute("remember", { fact: "Prefers tea over coffee", category: "preference" }, ctx));
    const b = parse(await execute("remember", { fact: "prefers tea over coffee" }, ctx));
    expect(b.memory_id).toBe(a.memory_id);
    expect(await memoryBlock(E.DB)).toContain("Prefers tea");
    await execute("forget", { memory_id: a.memory_id }, ctx);
    expect(await memoryBlock(E.DB)).not.toContain("Prefers tea");
  });
});

describe("google", () => {
  it("tools explain when Google isn't connected", async () => {
    const r = await execute("gmail_search", { query: "is:unread" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/not connected/);
  });

  it("builds a UTF-8 reply email", () => {
    const raw = buildRawEmail({ to: "a@b.com", subject: "Shipment ✓", body: "مرحبا", inReplyTo: "<x@y>" });
    const text = b64urlDecode(raw);
    expect(text).toContain("In-Reply-To: <x@y>");
    expect(text).toContain("Subject: =?UTF-8?B?");
    expect(text).toContain("مرحبا");
  });

  it("extracts body text, preferring plain text", () => {
    const enc = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_");
    expect(bodyText({ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: enc("<p>Hi <b>there</b></p>") } },
      { mimeType: "text/plain", body: { data: enc("Hi there") } },
    ] })).toBe("Hi there");
    expect(bodyText({ mimeType: "text/html", body: { data: enc("<style>x{}</style><p>Hello&nbsp;Dubai</p>") } })).toBe("Hello Dubai");
  });
});

it("tool definitions are sorted and strict", () => {
  const defs = definitions();
  expect(defs.map((d) => d.name)).toEqual([...defs.map((d) => d.name)].sort());
  for (const d of defs) {
    expect(d.input_schema.additionalProperties).toBe(false);
    expect(d.eager_input_streaming).toBe(true);
  }
});

// --- agent loop with a fake Claude ------------------------------------------------

type Block = Record<string, unknown>;
function fakeClaude(responses: { content: Block[]; stop_reason: string }[]) {
  const calls: Record<string, unknown>[] = [];
  setClientFactory(() => ({
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push({ ...params, messages: [...(params.messages as unknown[])] });
          const msg = { id: "msg_x", type: "message", role: "assistant", model: "m", stop_sequence: null, usage: {}, ...responses.shift()! };
          return {
            async *[Symbol.asyncIterator]() {
              for (const b of msg.content) {
                if (b.type === "tool_use") yield { type: "content_block_start", content_block: b };
                if (b.type === "text") yield { type: "content_block_delta", delta: { type: "text_delta", text: b.text } };
              }
            },
            finalMessage: async () => msg,
          };
        },
      },
    },
  }) as never);
  return calls;
}

async function turn(convId: number, text: string) {
  const events: [string, unknown][] = [];
  await runTurn(E, convId, text, (e, d) => events.push([e, d]));
  return events;
}

describe("agent loop", () => {
  it("runs a tool, then answers, and stores alternating history", async () => {
    const calls = fakeClaude([
      { content: [{ type: "tool_use", id: "toolu_1", name: "add_task", input: { title: "Call Maersk" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Done. Added **Call Maersk**." }], stop_reason: "end_turn" },
    ]);
    const conv = await db.createConversation(E.DB);
    const events = await turn(conv, "remind me to call Maersk");

    expect(events).toContainEqual(["status", "Adding task…"]);
    expect(events).toContainEqual(["refresh", "tasks"]);
    expect(events.filter(([e]) => e === "text").map(([, d]) => d).join("")).toContain("Added **Call Maersk**");
    expect((await db.all(E.DB, "SELECT title FROM tasks"))[0]).toEqual({ title: "Call Maersk" });

    expect((await db.loadMessages(E.DB, conv)).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const second = calls[1].messages as { content: Block[] }[];
    expect(second.at(-1)!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });

    const first = calls[0];
    expect(first).toMatchObject({ model: "claude-opus-5-5", thinking: { type: "adaptive" }, fallbacks: "default" });
    expect(first.betas).toContain("server-side-fallback-2026-07-01");
    expect((first.tools as Block[]).some((t) => t.type === "web_search_20260209")).toBe(true);

    const view = await displayMessages(E, conv);
    expect(view[0]).toEqual({ role: "user", text: "remind me to call Maersk" });
    expect(view.at(-1)!.role).toBe("assistant");
  });

  it("keeps history valid after a refusal", async () => {
    fakeClaude([{ content: [], stop_reason: "refusal" }]);
    const conv = await db.createConversation(E.DB);
    const events = await turn(conv, "hi");
    expect(events.some(([e]) => e === "error")).toBe(true);
    expect((await db.loadMessages(E.DB, conv)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("reports an API failure to the phone", async () => {
    setClientFactory(() => ({ beta: { messages: { stream() { throw new Error("boom"); } } } }) as never);
    const conv = await db.createConversation(E.DB);
    const events = await turn(conv, "hi");
    expect(events).toContainEqual(["error", "Unexpected error: Error"]);
    expect((await db.loadMessages(E.DB, conv)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

// --- HTTP ------------------------------------------------------------------------------

describe("http", () => {
  const worker = (exports as { default: { fetch: typeof fetch } }).default;
  const req = (path: string, init?: RequestInit) => worker.fetch(`https://jarvis.test${path}`, init);

  it("requires login for the API", async () => {
    expect((await req("/api/tasks")).status).toBe(401);
    expect(await (await req("/api/status")).json()).toEqual({ authed: false, configured: true });
    const bad = await req("/api/login", { method: "POST", body: JSON.stringify({ password: "wrong" }) });
    expect(bad.status).toBe(401);
  });

  it("logs in and uses the session cookie", async () => {
    const ok = await req("/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("Set-Cookie")!.split(";")[0];
    expect(ok.headers.get("Set-Cookie")).toContain("HttpOnly");

    const headers = { Cookie: cookie };
    expect((await (await req("/api/status", { headers })).json()) as object).toMatchObject({ authed: true, google_connected: false });
    const t = await req("/api/tasks", { method: "POST", headers, body: JSON.stringify({ title: "Check DO validity" }) });
    expect(t.status).toBe(200);
    expect(await (await req("/api/tasks", { headers })).json()).toHaveLength(1);
    expect((await req("/api/tasks", { headers: { Cookie: "jarvis_session=forged" } })).status).toBe(401);
  });

  it("streams a chat over SSE", async () => {
    fakeClaude([{ content: [{ type: "text", text: "Hello, sir." }], stop_reason: "end_turn" }]);
    const login = await req("/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }) });
    const Cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const res = await req("/api/chat", { method: "POST", headers: { Cookie }, body: JSON.stringify({ message: "hi" }) });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: conversation");
    expect(text).toContain('data: "Hello, sir."');
    expect(text).toContain("event: done");
  });

  it("rejects the Google callback without a valid state", async () => {
    const res = await req("/google/callback?state=nope&code=x");
    expect(res.status).toBe(400);
  });
});
