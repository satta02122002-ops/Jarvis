"""FastAPI server: login, chat streaming, tasks/memories, Google connect, and the PWA."""

import hashlib
import hmac
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import brain, config, db, google_auth
from .tools import memory as memory_tools
from .tools import tasks as task_tools

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
config.validate()

app = FastAPI(title="Jarvis", docs_url=None, redoc_url=None)
STATIC = Path(__file__).resolve().parent.parent / "static"
COOKIE = "jarvis_session"
# /google/callback is public because iOS may finish the Google sign-in in a browser without the session
# cookie; it is still safe because it only accepts a one-time `state` minted by the logged-in /google/connect.
PUBLIC_PATHS = {"/", "/api/login", "/api/status", "/manifest.webmanifest", "/sw.js", "/healthz", "/google/callback"}


# --- auth -----------------------------------------------------------------------

def _session_token() -> str:
    # Changing APP_PASSWORD or SECRET_KEY signs every device out.
    secret = (config.SECRET_KEY or "dev").encode()
    return hmac.new(secret, f"jarvis:{config.APP_PASSWORD}".encode(), hashlib.sha256).hexdigest()


def _authed(request: Request) -> bool:
    if config.DEV_MODE and not config.APP_PASSWORD:
        return True
    return hmac.compare_digest(request.cookies.get(COOKIE, ""), _session_token())


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/static/") or _authed(request):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Not logged in"}, status_code=401)
    return RedirectResponse("/")


class Login(BaseModel):
    password: str


@app.post("/api/login")
async def login(body: Login):
    if not config.APP_PASSWORD or not hmac.compare_digest(body.password, config.APP_PASSWORD):
        raise HTTPException(401, "Wrong password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        COOKIE, _session_token(), max_age=60 * 60 * 24 * 180, httponly=True,
        secure=config.PUBLIC_URL.startswith("https"), samesite="lax",
    )
    return resp


@app.post("/api/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE)
    return resp


# --- pages ----------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
async def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# --- status ---------------------------------------------------------------------

@app.get("/api/status")
async def status(request: Request):
    if not _authed(request):
        return {"authed": False}
    return {
        "authed": True,
        "owner": config.OWNER_NAME,
        "model": config.MODEL,
        "google_configured": config.google_configured(),
        "google_connected": google_auth.connected(),
    }


# --- chat -----------------------------------------------------------------------

class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    conversation_id: int | None = None


@app.post("/api/chat")
async def chat(body: ChatIn):
    conv_id = body.conversation_id
    if conv_id is None or db.get_conversation(conv_id) is None:
        title = body.message.strip().splitlines()[0][:50] or "New chat"
        conv_id = db.create_conversation(title)

    async def gen():
        yield brain._sse("conversation", {"id": conv_id})
        async for chunk in brain.run_turn(conv_id, body.message.strip()):
            yield chunk

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/conversations")
async def conversations():
    return db.list_conversations()


@app.get("/api/conversations/{conv_id}")
async def conversation(conv_id: int):
    conv = db.get_conversation(conv_id)
    if conv is None:
        raise HTTPException(404)
    return {**conv, "messages": brain.display_messages(conv_id)}


@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: int):
    db.delete_conversation(conv_id)
    return {"ok": True}


# --- tasks & memories (for the side panel) --------------------------------------

@app.get("/api/tasks")
async def get_tasks(status: str = "open"):
    if status not in ("open", "done", "all"):
        raise HTTPException(400)
    return task_tools.list_tasks(status)["tasks"]


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    due: str | None = None


@app.post("/api/tasks")
async def create_task(body: TaskIn):
    try:
        return task_tools.add_task(body.title, due=body.due or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/tasks/{task_id}/toggle")
async def toggle_task(task_id: int):
    rows = db.q("SELECT status FROM tasks WHERE id = ?", (task_id,))
    if not rows:
        raise HTTPException(404)
    return task_tools.update_task(task_id, status="open" if rows[0]["status"] == "done" else "done")


@app.delete("/api/tasks/{task_id}")
async def remove_task(task_id: int):
    return task_tools.delete_task(task_id)


@app.get("/api/memories")
async def get_memories():
    return memory_tools.all_memories()


@app.delete("/api/memories/{memory_id}")
async def remove_memory(memory_id: int):
    return memory_tools.forget(memory_id)


# --- Google ---------------------------------------------------------------------

@app.get("/google/connect")
async def google_connect():
    if not config.google_configured():
        return HTMLResponse("<p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README).</p>", 400)
    return RedirectResponse(google_auth.authorization_url())


@app.get("/google/callback")
async def google_callback(state: str = "", code: str = "", error: str = ""):
    if error:
        return RedirectResponse("/?google=error")
    try:
        google_auth.handle_callback(state, code)
    except Exception as e:
        logging.getLogger("jarvis").exception("Google OAuth failed")
        return HTMLResponse(f"<p>Google connection failed: {type(e).__name__}. <a href='/'>Back to Jarvis</a></p>", 400)
    return RedirectResponse("/?google=connected")


@app.post("/api/google/disconnect")
async def google_disconnect():
    google_auth.disconnect()
    return {"ok": True}
