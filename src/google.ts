/** Google OAuth (web flow) + a tiny authenticated fetch helper for Gmail and Calendar. */
import { deleteSetting, getSetting, setSetting } from "./db";
import type { Env } from "./env";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose", // create drafts; Jarvis never sends
  "https://www.googleapis.com/auth/calendar.events",
];

const TOKEN_KEY = "google_token";
const STATE_PREFIX = "google_state:";
const STATE_TTL_MS = 10 * 60_000;

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

export class GoogleNotConnected extends Error {}

export const redirectUri = (origin: string) => `${origin}/google/callback`;

export async function authorizationUrl(env: Env, origin: string) {
  const state = crypto.randomUUID();
  await setSetting(env.DB, STATE_PREFIX + state, String(Date.now()));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleCallback(env: Env, origin: string, state: string, code: string) {
  const created = await getSetting(env.DB, STATE_PREFIX + state);
  if (state) await deleteSetting(env.DB, STATE_PREFIX + state); // one-time use
  if (!created || Date.now() - Number(created) > STATE_TTL_MS) {
    throw new Error("Unknown or expired sign-in attempt. Please tap Connect again.");
  }
  const tok = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin),
  });
  await saveToken(env, tok);
}

async function tokenRequest(env: Env, body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  return json as { access_token: string; refresh_token?: string; expires_in: number };
}

async function saveToken(env: Env, tok: { access_token: string; refresh_token?: string; expires_in: number }, prevRefresh?: string) {
  const stored: StoredToken = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? prevRefresh,
    expires_at: Date.now() + (tok.expires_in - 60) * 1000,
  };
  await setSetting(env.DB, TOKEN_KEY, JSON.stringify(stored));
}

export async function accessToken(env: Env): Promise<string> {
  const raw = await getSetting(env.DB, TOKEN_KEY);
  if (!raw) throw new GoogleNotConnected();
  const tok = JSON.parse(raw) as StoredToken;
  if (Date.now() < tok.expires_at) return tok.access_token;
  if (!tok.refresh_token) throw new GoogleNotConnected();
  try {
    const fresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tok.refresh_token });
    await saveToken(env, fresh, tok.refresh_token);
    return fresh.access_token;
  } catch (e) {
    if (String(e).includes("invalid_grant")) {
      await disconnect(env); // revoked or expired (e.g. 7-day limit in Google "Testing" mode)
      throw new GoogleNotConnected();
    }
    throw e;
  }
}

export const isConnected = async (env: Env) => (await getSetting(env.DB, TOKEN_KEY)) !== null;
export const disconnect = (env: Env) => deleteSetting(env.DB, TOKEN_KEY);

/** Authenticated JSON call to a Google API. */
export async function gapi<T = Record<string, unknown>>(env: Env, url: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return {} as T;
  const text = await res.text();
  if (!res.ok) throw new Error(`Google API ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
