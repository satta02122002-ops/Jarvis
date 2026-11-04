/** iPhone Shortcuts endpoint + Apple Reminder/Calendar tools. Claude is replaced by a fake client. */
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClient, setClientFactory, SHORTCUT_NOTE } from "../src/brain";
import * as db from "../src/db";
import type { Env } from "../src/env";
import { handleShortcut, plainText } from "../src/shortcut";
import { phoneDate } from "../src/tools/apple";
import { definitions, emptyActions, execute } from "../src/tools/registry";

const E = env as unknown as Env;
const realFactory = makeClient;
afterEach(() => setClientFactory(realFactory));
beforeEach(async () => {
  await E.DB.batch(["messages", "conversations", "tasks", "memories", "settings"].map((t) => E.DB.prepare(`DELETE FROM ${t}`)));
});

type Block = Record<string, unknown>;
function fakeClaude(responses: { content: Block[]; stop_reason: string }[]) {
  const calls: Record<string, unknown>[] = [];
  setClientFactory(() => ({
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push({ ...params, messages: [...(params.messages as unknown[])] });
          const msg = { id: "m", type: "message", role: "assistant", model: "m", stop_sequence: null, usage: {}, ...responses.shift()! };
          return {
            async *[Symbol.asyncIterator]() {
              for (const b of msg.content) {
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

const worker = (exports as { default: { fetch: typeof fetch } }).default;
const call = (init: RequestInit & { key?: string | null } = {}) => {
  const { key = "shortcut-test-key", ...rest } = init;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(rest.headers as Record<string, string>) };
  if (key) headers.Authorization = `Bearer ${key}`;
  return worker.fetch("https://jarvis.test/api/shortcut", { ...rest, headers });
};

describe("phone helpers", () => {
  it("formats dates the way Shortcuts reads them", () => {
    expect(phoneDate("2026-11-05T09:00+04:00")).toBe("November 5, 2026 at 9:00 AM");
    expect(phoneDate("2026-11-05T00:05+04:00")).toBe("November 5, 2026 at 12:05 AM");
    expect(phoneDate("2026-12-31T12:30+04:00")).toBe("December 31, 2026 at 12:30 PM");
    expect(phoneDate("2026-01-01T23:59+04:00")).toBe("January 1, 2026 at 11:59 PM");
  });

  it("strips markdown for Siri", () => {
    expect(plainText("## Today\n- **Call** Maersk\n- Check [DO](https://x.y) `status`")).toBe("Today\n• Call Maersk\n• Check DO status");
  });
});

describe("apple tools", () => {
  it("are only offered on the Shortcuts channel", async () => {
    const web = definitions("web").map((d) => d.name);
    const phone = definitions("shortcut").map((d) => d.name);
    expect(web).not.toContain("create_iphone_reminder");
    expect(phone).toContain("create_iphone_reminder");
    expect(phone).toContain("create_iphone_calendar_event");
    expect(phone).toContain("add_task");
    const r = await execute("create_iphone_reminder", { title: "x" }, { env: E, channel: "web" });
    expect(r).toMatchObject({ isError: true, text: "Unknown tool: create_iphone_reminder" });
  });

  it("queue reminders and events for the phone", async () => {
    const actions = emptyActions();
    const ctx = { env: E, channel: "shortcut" as const, actions };
    expect((await execute("create_iphone_reminder", { title: "Call Maersk", due: "2026-11-05T09:00" }, ctx)).isError).toBe(false);
    expect((await execute("create_iphone_reminder", { title: "Buy milk" }, ctx)).isError).toBe(false);
    expect((await execute("create_iphone_calendar_event", { title: "DP World sync", start: "2026-11-05T14:30" }, ctx)).isError).toBe(false);
    expect((await execute("create_iphone_calendar_event", { title: "Bad", start: "2026-11-05T14:30", end: "2026-11-05T14:00" }, ctx)).isError).toBe(true);

    expect(actions.reminders).toEqual([
      { title: "Call Maersk", notes: "", due: "November 5, 2026 at 9:00 AM", due_iso: "2026-11-05T09:00+04:00" },
      { title: "Buy milk", notes: "", due: "", due_iso: "" },
    ]);
    expect(actions.events).toHaveLength(1);
    expect(actions.events[0]).toMatchObject({ start: "November 5, 2026 at 2:30 PM", end: "November 5, 2026 at 3:00 PM" });
  });
});

describe("/api/shortcut", () => {
  it("requires the Shortcut key", async () => {
    expect((await call({ method: "GET", key: null })).status).toBe(401);
    expect((await call({ method: "GET", key: "wrong" })).status).toBe(401);
    const ok = await call({ method: "GET" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, reminders: [], events: [] });
  });

  it("explains when the key isn't configured", async () => {
    const res = await handleShortcut(new Request("https://jarvis.test/api/shortcut"), { ...E, SHORTCUT_TOKEN: undefined });
    expect(res.status).toBe(503);
  });

  it("sets an iPhone reminder and answers in plain text", async () => {
    const calls = fakeClaude([
      {
        content: [{ type: "tool_use", id: "t1", name: "create_iphone_reminder", input: { title: "Call Maersk", due: "2026-11-05T09:00" } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "**Done.** Reminder set for 9 AM tomorrow: call Maersk." }], stop_reason: "end_turn" },
    ]);
    const res = await call({ method: "POST", body: JSON.stringify({ message: "remind me to call Maersk tomorrow at 9" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reply).toBe("Done. Reminder set for 9 AM tomorrow: call Maersk.");
    expect(body.reminders).toEqual([{ title: "Call Maersk", notes: "", due: "November 5, 2026 at 9:00 AM", due_iso: "2026-11-05T09:00+04:00" }]);
    expect(body.events).toEqual([]);

    // Shortcut requests use the Siri style, the phone tools and the lighter effort.
    const first = calls[0] as { system: { text: string }[]; tools: { name?: string }[]; output_config: { effort: string } };
    expect(first.system[1].text).toContain(SHORTCUT_NOTE);
    expect(first.tools.map((t) => t.name)).toContain("create_iphone_reminder");
    expect(first.output_config.effort).toBe("low");
  });

  it("keeps one conversation per day and accepts plain-text bodies", async () => {
    fakeClaude([
      { content: [{ type: "text", text: "First." }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: "Second." }], stop_reason: "end_turn" },
    ]);
    const a = (await (await call({ method: "POST", body: JSON.stringify({ message: "hi" }) })).json()) as { conversation_id: number };
    const b = (await (await call({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "and again" })).json()) as {
      conversation_id: number; reply: string;
    };
    expect(b.reply).toBe("Second.");
    expect(b.conversation_id).toBe(a.conversation_id);
    expect((await db.getConversation(E.DB, a.conversation_id))!.title).toMatch(/^Siri · /);
    expect((await db.loadMessages(E.DB, a.conversation_id)).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("returns a spoken error instead of failing the Shortcut", async () => {
    setClientFactory(() => ({ beta: { messages: { stream() { throw new Error("boom"); } } } }) as never);
    const res = await call({ method: "POST", body: JSON.stringify({ message: "hi" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reply: "Sorry, something went wrong: Unexpected error: Error", error: expect.any(String) });
  });

  it("rejects empty messages", async () => {
    expect((await call({ method: "POST", body: JSON.stringify({ message: "  " }) })).status).toBe(400);
  });
});
