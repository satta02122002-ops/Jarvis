/** Cloudflare Worker entry: login, chat streaming, tasks/memories, Google connect. Static files come from ./public. */
import { configured, isAuthed, loginCookie, logoutCookie, safeEqual } from "./auth";
import { displayMessages, runTurn } from "./brain";
import * as db from "./db";
import { googleConfigured, model, ownerName, type Env } from "./env";
import * as google from "./google";
import { allMemories, forget } from "./tools/memory";
import { addTask, deleteTask, listTasks, updateTask } from "./tools/tasks";
import { ToolInputError } from "./tools/registry";

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

const err = (status: number, detail: string) => json({ detail }, status);

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Server-sent events response; `work` runs in the background and writes events as they happen. */
function sse(ctx: ExecutionContext, work: (emit: (event: string, data: unknown) => void) => Promise<void>) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const emit = (event: string, data: unknown) => {
    if (!open) return;
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {
      open = false; // phone disconnected; keep working so the reply is still saved
    });
  };
  const job = work(emit)
    .catch((e) => {
      console.error("Chat turn failed", e);
      emit("error", "Something went wrong on the server.");
    })
    .finally(() => {
      if (open) writer.close().catch(() => {});
    });
  ctx.waitUntil(job);
  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const { pathname: path } = url;
  const method = req.method;

  // --- public routes ------------------------------------------------------------
  if (path === "/api/status" && method === "GET") {
    if (!(await isAuthed(req, env))) return json({ authed: false, configured: configured(env) });
    return json({
      authed: true,
      owner: ownerName(env),
      model: model(env),
      google_configured: googleConfigured(env),
      google_connected: await google.isConnected(env),
    });
  }

  if (path === "/api/login" && method === "POST") {
    if (!configured(env)) return err(500, "Server not set up: APP_PASSWORD and SECRET_KEY secrets are missing.");
    const { password = "" } = await body<{ password?: string }>(req);
    if (!(await safeEqual(String(password), env.APP_PASSWORD!))) return err(401, "Wrong password");
    return json({ ok: true }, 200, { "Set-Cookie": await loginCookie(env, url.protocol === "https:") });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": logoutCookie() });
  }

  // iOS may finish Google sign-in in a browser without the session cookie, so the callback is public.
  // It's still safe: it only accepts a one-time `state` minted by the logged-in /google/connect.
  if (path === "/google/callback" && method === "GET") {
    if (url.searchParams.get("error")) return Response.redirect(`${url.origin}/?google=error`, 302);
    try {
      await google.handleCallback(env, url.origin, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
    } catch (e) {
      console.error("Google OAuth failed", e);
      return new Response(
        `<p>Google connection failed: ${(e as Error).message.replace(/[<>&]/g, "")}</p><p><a href="/">Back to Jarvis</a></p>`,
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    return Response.redirect(`${url.origin}/?google=connected`, 302);
  }

  // --- everything below needs login ----------------------------------------------
  if (!(await isAuthed(req, env))) {
    return path.startsWith("/api/") ? err(401, "Not logged in") : Response.redirect(`${url.origin}/`, 302);
  }

  if (path === "/google/connect" && method === "GET") {
    if (!googleConfigured(env)) return err(400, "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README).");
    return Response.redirect(await google.authorizationUrl(env, url.origin), 302);
  }
  if (path === "/api/google/disconnect" && method === "POST") {
    await google.disconnect(env);
    return json({ ok: true });
  }

  // chat
  if (path === "/api/chat" && method === "POST") {
    const b = await body<{ message?: string; conversation_id?: number | null }>(req);
    const message = String(b.message ?? "").trim();
    if (!message || message.length > 20000) return err(400, "Message must be 1-20000 characters.");
    let convId = Number(b.conversation_id) || 0;
    if (!convId || !(await db.getConversation(env.DB, convId))) {
      convId = await db.createConversation(env.DB, message.split("\n")[0].slice(0, 50) || "New chat");
    }
    return sse(ctx, async (emit) => {
      emit("conversation", { id: convId });
      await runTurn(env, convId, message, emit);
      emit("done", { conversation_id: convId });
    });
  }

  // conversations
  if (path === "/api/conversations" && method === "GET") return json(await db.listConversations(env.DB));
  let m = /^\/api\/conversations\/(\d+)$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    if (method === "GET") {
      const conv = await db.getConversation(env.DB, id);
      if (!conv) return err(404, "Not found");
      return json({ ...conv, messages: await displayMessages(env, id) });
    }
    if (method === "DELETE") {
      await db.deleteConversation(env.DB, id);
      return json({ ok: true });
    }
  }

  // tasks
  if (path === "/api/tasks" && method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    if (!["open", "done", "all"].includes(status)) return err(400, "Bad status");
    return json((await listTasks(env.DB, status as "open" | "done" | "all")).tasks);
  }
  if (path === "/api/tasks" && method === "POST") {
    const b = await body<{ title?: string; due?: string }>(req);
    const title = String(b.title ?? "").trim();
    if (!title || title.length > 300) return err(400, "Title must be 1-300 characters.");
    return json(await addTask(env.DB, { title, due: b.due }));
  }
  if ((m = /^\/api\/tasks\/(\d+)\/toggle$/.exec(path)) && method === "POST") {
    const t = await db.first<{ status: string }>(env.DB, "SELECT status FROM tasks WHERE id = ?", Number(m[1]));
    if (!t) return err(404, "Not found");
    return json(await updateTask(env.DB, { task_id: Number(m[1]), status: t.status === "done" ? "open" : "done" }));
  }
  if ((m = /^\/api\/tasks\/(\d+)$/.exec(path)) && method === "DELETE") return json(await deleteTask(env.DB, Number(m[1])));

  // memories
  if (path === "/api/memories" && method === "GET") return json(await allMemories(env.DB));
  if ((m = /^\/api\/memories\/(\d+)$/.exec(path)) && method === "DELETE") return json(await forget(env.DB, Number(m[1])));

  return err(404, "Not found");
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.message);
      if (e instanceof ToolInputError) return err(400, e.message);
      console.error("Unhandled error", e);
      return err(500, "Internal error");
    }
  },
} satisfies ExportedHandler<Env>;
