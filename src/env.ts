export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  OWNER_NAME?: string;
  JARVIS_MODEL?: string;
  JARVIS_EFFORT?: string;
  JARVIS_SHORTCUT_EFFORT?: string;

  // secrets
  ANTHROPIC_API_KEY?: string;
  APP_PASSWORD?: string;
  SECRET_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Bearer token the iPhone Shortcuts send to /api/shortcut. */
  SHORTCUT_TOKEN?: string;
}

/** Dubai is UTC+4 all year (no daylight saving), so a fixed offset is exact. */
export const TZ = "Asia/Dubai";
export const TZ_OFFSET = "+04:00";

export const model = (env: Env) => env.JARVIS_MODEL || "claude-opus-5-5";
export const effort = (env: Env) =>
  (env.JARVIS_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";
export const ownerName = (env: Env) => env.OWNER_NAME || "Sattanathan";
export const googleConfigured = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
