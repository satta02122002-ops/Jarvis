/** Single-user password login with an HMAC-signed session cookie. */
import type { Env } from "./env";

export const COOKIE = "jarvis_session";
const MAX_AGE = 60 * 60 * 24 * 180; // 180 days
const enc = new TextEncoder();

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (via HMAC of both sides, so lengths don't leak). */
export async function safeEqual(a: string, b: string) {
  const k = "jarvis-compare";
  const [x, y] = await Promise.all([hmac(k, a), hmac(k, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Changing APP_PASSWORD or SECRET_KEY signs every device out. */
export const sessionToken = (env: Env) => hmac(env.SECRET_KEY!, `jarvis:${env.APP_PASSWORD}`);

export function readCookie(req: Request, name: string) {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

export function configured(env: Env) {
  return Boolean(env.APP_PASSWORD && env.SECRET_KEY);
}

export async function isAuthed(req: Request, env: Env) {
  if (!configured(env)) return false;
  const cookie = readCookie(req, COOKIE);
  return cookie !== "" && safeEqual(cookie, await sessionToken(env));
}

export async function loginCookie(env: Env, secure: boolean) {
  return `${COOKIE}=${await sessionToken(env)}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const logoutCookie = () => `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
