/** Long-term memory: facts Jarvis remembers about the user across chats. */
import { all, first, nowIso, run } from "../db";
import { defineTool } from "./registry";

const MAX_IN_PROMPT = 200;

export interface Memory {
  id: number;
  fact: string;
  category: string;
}

export async function remember(db: D1Database, fact: string, category = "general") {
  fact = fact.trim();
  const dup = await first<{ id: number }>(db, "SELECT id FROM memories WHERE lower(fact) = lower(?)", fact);
  if (dup) return { ok: true, memory_id: dup.id, note: "Already remembered." };
  const { id } = await run(db, "INSERT INTO memories (fact, category, created_at) VALUES (?, ?, ?)", fact, category, nowIso());
  return { ok: true, memory_id: id };
}

export async function forget(db: D1Database, id: number) {
  const { changes } = await run(db, "DELETE FROM memories WHERE id = ?", id);
  return { ok: changes > 0 };
}

export const allMemories = (db: D1Database) =>
  all<Memory>(db, "SELECT id, fact, category FROM memories ORDER BY category, id LIMIT ?", MAX_IN_PROMPT);

export async function memoryBlock(db: D1Database) {
  const rows = await allMemories(db);
  if (!rows.length) return "(nothing saved yet)";
  return rows.map((r) => `[${r.id}] (${r.category}) ${r.fact}`).join("\n");
}

defineTool({
  name: "remember",
  description:
    "Save a durable fact about the user (preferences, people, projects, goals, routines, work details) " +
    "so you remember it in future chats. One fact per call. Never save passwords, card numbers or other secrets.",
  properties: {
    fact: { type: "string", description: "The fact, written as a standalone sentence." },
    category: { type: "string", enum: ["personal", "work", "preference", "people", "project", "goal", "general"] },
  },
  required: ["fact"],
  run: (a, { env }) => remember(env.DB, String(a.fact), (a.category as string) ?? "general"),
});

defineTool({
  name: "forget",
  description: "Delete a remembered fact by its id (ids are shown in your memory list). Use when a fact is wrong or the user asks.",
  properties: { memory_id: { type: "integer" } },
  required: ["memory_id"],
  run: (a, { env }) => forget(env.DB, Number(a.memory_id)),
});
