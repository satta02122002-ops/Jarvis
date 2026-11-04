/**
 * iPhone Shortcuts endpoint. A Shortcut POSTs {"message": "..."} with `Authorization: Bearer <SHORTCUT_TOKEN>`
 * and gets back plain JSON it can act on:
 *   { reply, reminders: [{title, notes, due, due_iso}], events: [{title, notes, location, start, end, ...}], conversation_id }
 * The Shortcut shows/speaks `reply`, then creates each reminder/event with Apple's own actions.
 */
import { safeEqual } from "./auth";
import { runTurn } from "./brain";
import * as db from "./db";
import { ownerName, TZ, type Env } from "./env";
import { emptyActions } from "./tools/registry";

export const MAX_MESSAGE = 50_000; // room for shared emails / documents

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function authorized(req: Request, env: Env) {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token !== "" && (await safeEqual(token, env.SHORTCUT_TOKEN!));
}

/** Remove markdown so Siri doesn't read out asterisks and hashes. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One conversation per Dubai day, so follow-ups ("make it 10 instead") have context. */
async function todaysConversation(env: Env, fresh: boolean) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
  const key = `shortcut_conversation:${day}`;
  const existing = Number(await db.getSetting(env.DB, key));
  if (!fresh && existing && (await db.getConversation(env.DB, existing))) return existing;
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" }).format(new Date());
  const id = await db.createConversation(env.DB, `Siri · ${label}`);
  await db.setSetting(env.DB, key, String(id));
  return id;
}

async function readMessage(req: Request): Promise<{ message: string; fresh: boolean }> {
  const type = req.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as { message?: unknown; new_conversation?: unknown };
    return { message: String(b.message ?? "").trim(), fresh: b.new_conversation === true };
  }
  return { message: (await req.text()).trim(), fresh: false }; // plain-text body also works
}

export async function handleShortcut(req: Request, env: Env): Promise<Response> {
  if (!env.SHORTCUT_TOKEN) {
    return json({ error: "Shortcuts aren't set up yet: add the SHORTCUT_TOKEN secret in Cloudflare (see docs/SHORTCUTS.md)." }, 503);
  }
  if (!(await authorized(req, env))) return json({ error: "Wrong or missing Shortcut key." }, 401);

  if (req.method === "GET") {
    return json({ ok: true, reply: `Connected. Good to go, ${ownerName(env)}.`, reminders: [], events: [] });
  }
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const { message, fresh } = await readMessage(req);
  if (!message) return json({ error: "Empty message.", reply: "I didn't catch anything. Try again?", reminders: [], events: [] }, 400);
  if (message.length > MAX_MESSAGE) return json({ error: `Message too long (max ${MAX_MESSAGE} characters).` }, 413);

  const convId = await todaysConversation(env, fresh);
  const actions = emptyActions();
  let text = "";
  let error = "";
  await runTurn(env, convId, message, (event, data) => {
    if (event === "text") text += String(data);
    else if (event === "error") error = String(data);
  }, { channel: "shortcut", actions });

  const reply = plainText(text) || (error ? `Sorry, something went wrong: ${error}` : "Done.");
  return json({ reply, reminders: actions.reminders, events: actions.events, conversation_id: convId, ...(error ? { error } : {}) });
}
