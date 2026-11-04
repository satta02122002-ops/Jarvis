/**
 * iPhone-only tools (Shortcuts channel). Jarvis can't touch Apple Reminders or Calendar from the
 * server, so these tools queue the action; the Shortcut creates the reminder/event right after the
 * reply arrives, using Apple's own "Add New Reminder" / "Add New Event" actions.
 */
import { parseDue } from "./tasks";
import { defineTool, ToolInputError } from "./registry";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-05T09:00+04:00" → "November 5, 2026 at 9:00 AM" (Dubai time). A format Shortcuts turns into a date reliably. */
export function phoneDate(iso: string): string {
  const [date, time] = iso.slice(0, 16).split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${MONTHS[m - 1]} ${d}, ${y} at ${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

const addMinutes = (iso: string, minutes: number) => {
  const t = new Date(iso).getTime() + minutes * 60_000;
  return `${new Date(t + 4 * 3600_000).toISOString().slice(0, 16)}+04:00`;
};

defineTool({
  name: "create_iphone_reminder",
  description:
    "Create a native Apple Reminder on the user's iPhone (with an alert at the due time). Prefer this for any " +
    "'remind me' request on this channel. The reminder is created by the user's Shortcut right after your reply.",
  properties: {
    title: { type: "string" },
    due: { type: "string", description: "When to alert, ISO 8601 in Dubai time, e.g. 2026-11-05T09:00. Omit for no alert." },
    notes: { type: "string" },
  },
  required: ["title"],
  channels: ["shortcut"],
  run: async (a, { actions }) => {
    if (!actions) throw new ToolInputError("Only available from the iPhone Shortcut.");
    const dueIso = parseDue(a.due);
    actions.reminders.push({
      title: String(a.title).trim(),
      notes: String(a.notes ?? "").trim(),
      due: dueIso ? phoneDate(dueIso) : "",
      due_iso: dueIso ?? "",
    });
    return { ok: true, queued: "Apple Reminder will be created on the iPhone", due: dueIso ? phoneDate(dueIso) : "no alert" };
  },
});

defineTool({
  name: "create_iphone_calendar_event",
  description:
    "Add an event to the user's iPhone calendar (Apple Calendar, which includes any Google/Outlook calendars on the phone). " +
    "Created by the user's Shortcut right after your reply.",
  properties: {
    title: { type: "string" },
    start: { type: "string", description: "ISO 8601 in Dubai time, e.g. 2026-11-05T14:30" },
    end: { type: "string", description: "Optional; defaults to start + 30 minutes." },
    location: { type: "string" },
    notes: { type: "string" },
  },
  required: ["title", "start"],
  channels: ["shortcut"],
  run: async (a, { actions }) => {
    if (!actions) throw new ToolInputError("Only available from the iPhone Shortcut.");
    const startIso = parseDue(a.start)!;
    const endIso = a.end ? parseDue(a.end)! : addMinutes(startIso, 30);
    if (new Date(endIso) <= new Date(startIso)) throw new ToolInputError("end must be after start");
    actions.events.push({
      title: String(a.title).trim(),
      notes: String(a.notes ?? "").trim(),
      location: String(a.location ?? "").trim(),
      start: phoneDate(startIso),
      end: phoneDate(endIso),
      start_iso: startIso,
      end_iso: endIso,
    });
    return { ok: true, queued: "Calendar event will be added on the iPhone", start: phoneDate(startIso), end: phoneDate(endIso) };
  },
});
