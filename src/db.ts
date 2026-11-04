/** D1 storage: conversations, messages, tasks, memories, settings. */

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export type Row = Record<string, unknown>;

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

/** Run a write. Returns the inserted row id and number of changed rows. */
export async function run(db: D1Database, sql: string, ...params: unknown[]) {
  const res = await db.prepare(sql).bind(...params).run();
  return { id: Number(res.meta.last_row_id), changes: Number(res.meta.changes) };
}

// --- conversations -------------------------------------------------------------

export interface Conversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export async function createConversation(db: D1Database, title = "New chat") {
  const ts = nowIso();
  return (await run(db, "INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)", title.slice(0, 80), ts, ts)).id;
}

export const listConversations = (db: D1Database, limit = 30) =>
  all<Conversation>(db, "SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT ?", limit);

export const getConversation = (db: D1Database, id: number) =>
  first<Conversation>(db, "SELECT * FROM conversations WHERE id = ?", id);

export async function deleteConversation(db: D1Database, id: number) {
  await db.batch([
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
}

// --- messages ------------------------------------------------------------------

export interface StoredMessage {
  role: "user" | "assistant";
  content: unknown[];
}

export async function appendMessage(db: D1Database, convId: number, role: StoredMessage["role"], content: unknown[]) {
  const ts = nowIso();
  await db.batch([
    db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .bind(convId, role, JSON.stringify(content), ts),
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(ts, convId),
  ]);
}

export async function loadMessages(db: D1Database, convId: number): Promise<StoredMessage[]> {
  const rows = await all<{ role: StoredMessage["role"]; content: string }>(
    db, "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id", convId,
  );
  return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
}

// --- settings ------------------------------------------------------------------

export async function getSetting(db: D1Database, key: string) {
  return (await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key))?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string) {
  await run(db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

export async function deleteSetting(db: D1Database, key: string) {
  await run(db, "DELETE FROM settings WHERE key = ?", key);
}
