/** Task & reminder tools. */
import { all, first, nowIso, run } from "../db";
import { TZ_OFFSET } from "../env";
import { defineTool, ToolInputError, type Args } from "./registry";

export interface Task {
  id: number;
  title: string;
  notes: string;
  due: string | null;
  priority: "low" | "normal" | "high";
  status: "open" | "done";
  created_at: string;
  completed_at: string | null;
}

/** Accepts "2026-11-05T09:00" (Dubai local) or any ISO string with an offset; returns "+04:00"-normalized ISO. */
export function parseDue(due: unknown): string | null {
  if (due === undefined || due === null || due === "") return null;
  const s = String(due).trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) throw new ToolInputError("due must be ISO 8601, e.g. 2026-11-05T09:00");
  const [, date, time = "09:00", offset] = m;
  const d = new Date(`${date}T${time}:00${offset ?? TZ_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new ToolInputError("due is not a real date/time");
  // Re-express in Dubai time.
  const local = new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 16);
  return `${local}${TZ_OFFSET}`;
}

export async function addTask(db: D1Database, a: Args) {
  const title = String(a.title).trim();
  const due = parseDue(a.due);
  const priority = (a.priority as string) ?? "normal";
  const { id } = await run(
    db, "INSERT INTO tasks (title, notes, due, priority, created_at) VALUES (?, ?, ?, ?, ?)",
    title, String(a.notes ?? "").trim(), due, priority, nowIso(),
  );
  return { ok: true, task_id: id, title, due, priority };
}

export async function listTasks(db: D1Database, status: "open" | "done" | "all" = "open") {
  const where = status === "all" ? "" : "WHERE status = ?";
  const params = status === "all" ? [] : [status];
  const tasks = await all<Task>(
    db,
    `SELECT * FROM tasks ${where}
     ORDER BY status, due IS NULL, due,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id
     LIMIT 100`,
    ...params,
  );
  return { count: tasks.length, tasks };
}

export async function updateTask(db: D1Database, a: Args) {
  const id = Number(a.task_id);
  if (!(await first(db, "SELECT id FROM tasks WHERE id = ?", id))) return { ok: false, error: `No task with id ${id}` };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of ["title", "notes", "priority"] as const) {
    if (a[f] !== undefined && a[f] !== null) { sets.push(`${f} = ?`); params.push(a[f]); }
  }
  if (a.due !== undefined && a.due !== null) { sets.push("due = ?"); params.push(parseDue(a.due)); }
  if (a.status) {
    sets.push("status = ?", "completed_at = ?");
    params.push(a.status, a.status === "done" ? nowIso() : null);
  }
  if (!sets.length) return { ok: false, error: "Nothing to change" };
  await run(db, `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  return { ok: true, task: await first<Task>(db, "SELECT * FROM tasks WHERE id = ?", id) };
}

export async function deleteTask(db: D1Database, id: number) {
  const { changes } = await run(db, "DELETE FROM tasks WHERE id = ?", id);
  return { ok: changes > 0, deleted: changes };
}

const PRIORITY = { type: "string", enum: ["low", "normal", "high"] } as const;

defineTool({
  name: "add_task",
  description:
    "Add a task to the user's to-do list. To also get an iPhone notification at a specific time, " +
    "additionally call calendar_create_event (if Google is connected).",
  properties: {
    title: { type: "string", description: "Short task title." },
    notes: { type: "string", description: "Optional details." },
    due: { type: "string", description: "Optional due date/time, ISO 8601 in Dubai local time, e.g. 2026-11-05T09:00." },
    priority: { ...PRIORITY, enum: [...PRIORITY.enum] },
  },
  required: ["title"],
  run: (a, { env }) => addTask(env.DB, a),
});

defineTool({
  name: "list_tasks",
  description: "List the user's tasks. Default shows open tasks sorted by due date.",
  properties: { status: { type: "string", enum: ["open", "done", "all"] } },
  run: (a, { env }) => listTasks(env.DB, (a.status as "open" | "done" | "all") ?? "open"),
});

defineTool({
  name: "update_task",
  description: "Edit a task, mark it done, or reopen it. Look up task_id with list_tasks first if unsure.",
  properties: {
    task_id: { type: "integer" },
    title: { type: "string" },
    notes: { type: "string" },
    due: { type: "string", description: "ISO 8601 Dubai time, or empty string to clear." },
    priority: { ...PRIORITY, enum: [...PRIORITY.enum] },
    status: { type: "string", enum: ["open", "done"] },
  },
  required: ["task_id"],
  run: (a, { env }) => updateTask(env.DB, a),
});

defineTool({
  name: "delete_task",
  description: "Permanently delete a task (to complete it, use update_task with status=done instead).",
  properties: { task_id: { type: "integer" } },
  required: ["task_id"],
  run: (a, { env }) => deleteTask(env.DB, Number(a.task_id)),
});
