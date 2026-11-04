/** Tool registry: every custom tool Jarvis can call, plus a validating executor. */
import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

type JsonType = "string" | "integer" | "boolean" | "number";
export interface Prop {
  type: JsonType;
  description?: string;
  enum?: string[];
}

export type Channel = "web" | "shortcut";

/** An action for the iPhone Shortcut to carry out with Apple's own apps after the reply arrives. */
export interface PhoneReminder { title: string; notes: string; due: string; due_iso: string }
export interface PhoneEvent { title: string; notes: string; location: string; start: string; end: string; start_iso: string; end_iso: string }
export interface PhoneActions { reminders: PhoneReminder[]; events: PhoneEvent[] }
export const emptyActions = (): PhoneActions => ({ reminders: [], events: [] });

export interface ToolCtx {
  env: Env;
  channel?: Channel;
  /** Present on the Shortcuts channel: tools queue Apple Reminders / Calendar actions here. */
  actions?: PhoneActions;
}

export type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Prop>;
  required?: string[];
  /** Channels this tool is offered on (default: all). */
  channels?: Channel[];
  run: (args: Args, ctx: ToolCtx) => Promise<unknown>;
}

const REGISTRY = new Map<string, ToolDef>();

export function defineTool(def: ToolDef) {
  REGISTRY.set(def.name, def);
  return def;
}

export class ToolInputError extends Error {}

export function definitions(channel: Channel = "web"): Anthropic.Beta.BetaTool[] {
  // Sorted so the tools block is byte-identical every request (keeps the prompt cache warm).
  return [...REGISTRY.values()]
    .filter((t) => !t.channels || t.channels.includes(channel))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: t.properties,
        required: t.required ?? [],
        additionalProperties: false,
      },
      // Stream tool arguments as they're generated; we validate them ourselves in validate().
      eager_input_streaming: true,
    }));
}

const checks: Record<JsonType, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
};

export function validate(def: ToolDef, input: unknown): Args {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError("Tool input must be a JSON object.");
  }
  const args = input as Args;
  const missing = (def.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) throw new ToolInputError(`Missing required field(s): ${missing.join(", ")}`);
  for (const [k, v] of Object.entries(args)) {
    const prop = def.properties[k];
    if (!prop) throw new ToolInputError(`Unknown field: ${k}`);
    if (v === null || v === undefined) continue;
    if (!checks[prop.type](v)) throw new ToolInputError(`Field '${k}' should be ${prop.type}.`);
    if (prop.enum && !prop.enum.includes(v as string)) {
      throw new ToolInputError(`Field '${k}' must be one of ${prop.enum.join(", ")}.`);
    }
  }
  return args;
}

/** Run a tool. Never throws: errors come back as text for the model, with isError set. */
export async function execute(name: string, input: unknown, ctx: ToolCtx): Promise<{ text: string; isError: boolean }> {
  const def = REGISTRY.get(name);
  if (!def || (def.channels && !def.channels.includes(ctx.channel ?? "web"))) {
    return { text: `Unknown tool: ${name}`, isError: true };
  }
  try {
    const result = await def.run(validate(def, input), ctx);
    return { text: typeof result === "string" ? result : JSON.stringify(result), isError: false };
  } catch (e) {
    if (e instanceof ToolInputError) return { text: `INVALID_INPUT: ${e.message}`, isError: true };
    console.error(`Tool ${name} failed`, e);
    const err = e as Error;
    return { text: `Tool error: ${err.name}: ${err.message}`, isError: true };
  }
}
