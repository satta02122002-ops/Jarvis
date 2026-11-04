// JARVIS front end: login, streaming chat, voice, tasks, memory, settings.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = { convId: null, busy: false, showDone: false, tts: false, status: {} };
try {
  state.convId = Number(localStorage.getItem("convId")) || null;
  state.tts = localStorage.getItem("tts") === "1";
} catch {}
const save = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Not logged in"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

// ---------- markdown ----------
function md(text) {
  if (window.marked && window.DOMPurify) {
    const html = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
    const t = document.createElement("template");
    t.innerHTML = html;
    t.content.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
    return t.innerHTML;
  }
  const d = document.createElement("div"); d.textContent = text; return d.innerHTML.replace(/\n/g, "<br>");
}

// ---------- screens ----------
function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); $("#password").focus(); }
async function showApp() {
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  greet();
  if (state.convId) await openConversation(state.convId).catch(() => newChat());
  refreshSettings();
}
function greet() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Dubai" }).format(new Date()));
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = `${part}, ${state.status.owner || "sir"}.`;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#password").value } });
    state.status = await api("/api/status");
    showApp();
  } catch (err) { $("#login-error").textContent = err.message; }
});

// ---------- chat ----------
const messagesEl = $("#messages");
const scrollDown = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };

function addBubble(role, text, extra = "") {
  $("#welcome").classList.add("hidden");
  const div = document.createElement("div");
  div.className = `msg ${role} ${extra}`;
  if (role === "user") div.textContent = text; else div.innerHTML = md(text);
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

function clearMessages() {
  messagesEl.querySelectorAll(".msg, .status-chip").forEach((n) => n.remove());
  $("#welcome").classList.remove("hidden");
}

async function openConversation(id) {
  const conv = await api(`/api/conversations/${id}`);
  state.convId = id; save("convId", id);
  clearMessages();
  conv.messages.forEach((m) => addBubble(m.role, m.text));
}

function newChat() {
  state.convId = null; save("convId", null);
  clearMessages(); greet(); closeDrawer(); $("#input").focus();
}

function setBusy(b) {
  state.busy = b;
  $("#send-btn").disabled = b;
  $(".topbar").classList.toggle("thinking", b);
  $("#status-line").textContent = b ? "Thinking…" : "Online";
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  addBubble("user", text);
  $("#input").value = ""; autosize();
  setBusy(true);
  speechSynthesis?.cancel?.();

  let bubble = null, full = "", statusEl = null;
  const ensureBubble = () => { if (!bubble) bubble = addBubble("assistant", "", "cursor"); return bubble; };
  const setStatus = (t) => {
    if (!statusEl) { statusEl = document.createElement("div"); statusEl.className = "status-chip"; messagesEl.appendChild(statusEl); }
    statusEl.textContent = t; $("#status-line").textContent = t; scrollDown();
  };
  const clearStatus = () => { statusEl?.remove(); statusEl = null; };

  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversation_id: state.convId }),
    });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok || !res.body) throw new Error(`Server error ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let renderQueued = false;
    const render = () => {
      if (renderQueued) return; renderQueued = true;
      requestAnimationFrame(() => { renderQueued = false; ensureBubble().innerHTML = md(full); scrollDown(); });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1];
        const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
        if (!ev || dataLine == null) continue;
        const data = JSON.parse(dataLine);
        if (ev === "conversation") { state.convId = data.id; save("convId", data.id); }
        else if (ev === "status") { setStatus(data); }
        else if (ev === "text") {
          clearStatus();
          if (!full.trim() && !data.trim()) continue;
          full += data; render();
        }
        else if (ev === "refresh") { data === "tasks" ? loadTasks() : loadMemories(); }
        else if (ev === "error") { clearStatus(); addBubble("assistant", `⚠️ ${data}`, "error"); }
      }
    }
    clearStatus();
    if (bubble) { bubble.classList.remove("cursor"); bubble.innerHTML = md(full.trim()); }
    if (state.tts && full.trim()) speak(full);
  } catch (err) {
    clearStatus();
    bubble?.classList.remove("cursor");
    addBubble("assistant", `⚠️ ${err.message}. Check your connection and try again.`, "error");
  } finally {
    setBusy(false);
    loadChats();
  }
}

$("#composer").addEventListener("submit", (e) => { e.preventDefault(); send($("#input").value); });
$("#input").addEventListener("keydown", (e) => {
  // Enter sends on hardware keyboards; on iPhone the keyboard's return key adds a newline, use the send button.
  if (e.key === "Enter" && !e.shiftKey && !/iPhone|iPad/.test(navigator.userAgent)) { e.preventDefault(); send($("#input").value); }
});
function autosize() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }
$("#input").addEventListener("input", autosize);
$$(".chip").forEach((c) => c.addEventListener("click", () => send(c.dataset.q)));
$("#new-chat").addEventListener("click", newChat);

// ---------- voice ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const mic = $("#mic-btn");
  mic.classList.remove("hidden");
  let rec = null;
  mic.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
    const base = $("#input").value ? $("#input").value + " " : "";
    rec.onresult = (e) => {
      const t = [...e.results].map((r) => r[0].transcript).join("");
      $("#input").value = base + t; autosize();
      if (e.results[e.results.length - 1].isFinal) { rec.stop(); }
    };
    rec.onend = () => {
      mic.classList.remove("listening"); rec = null;
      if ($("#input").value.trim() && state.tts) send($("#input").value); // hands-free mode
    };
    rec.onerror = () => { mic.classList.remove("listening"); rec = null; };
    mic.classList.add("listening");
    rec.start();
  });
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const plain = text.replace(/```[\s\S]*?```/g, " code block. ").replace(/[*_#>`|]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1");
  const u = new SpeechSynthesisUtterance(plain.slice(0, 1500));
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /Daniel|Arthur|en-GB/i.test(v.name + v.lang)) || null;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

// ---------- drawer ----------
function openDrawer() { $("#drawer").classList.add("open"); $("#scrim").classList.remove("hidden"); loadChats(); }
function closeDrawer() { $("#drawer").classList.remove("open"); $("#scrim").classList.add("hidden"); }
$("#menu-btn").addEventListener("click", openDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== t.dataset.tab));
  ({ chats: loadChats, tasks: loadTasks, memory: loadMemories, settings: refreshSettings })[t.dataset.tab]();
}));

function li(html, cls = "") { const el = document.createElement("li"); el.className = cls; el.innerHTML = html; return el; }
const esc = (s) => { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; };
const fmtDue = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

async function loadChats() {
  const list = $("#chat-list");
  const chats = await api("/api/conversations").catch(() => []);
  list.innerHTML = "";
  if (!chats.length) list.appendChild(li('<span class="muted">No chats yet.</span>'));
  chats.forEach((c) => {
    const el = li(`<div class="grow"><div class="ttl">${esc(c.title)}</div><div class="muted small">${new Date(c.updated_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div></div><button class="x" aria-label="Delete">×</button>`, c.id === state.convId ? "active" : "");
    el.querySelector(".grow").addEventListener("click", async () => { await openConversation(c.id); closeDrawer(); });
    el.querySelector(".x").addEventListener("click", async () => {
      if (!confirm("Delete this chat?")) return;
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (c.id === state.convId) newChat();
      loadChats();
    });
    list.appendChild(el);
  });
}

async function loadTasks() {
  const list = $("#task-list");
  const tasks = await api(`/api/tasks?status=${state.showDone ? "all" : "open"}`).catch(() => []);
  list.innerHTML = "";
  if (!tasks.length) list.appendChild(li('<span class="muted">Nothing on your list. 🎉</span>'));
  tasks.forEach((t) => {
    const el = li(`<button class="check" aria-label="Toggle done"></button><div class="grow"><div class="ttl">${esc(t.title)}</div>${t.due ? `<div class="muted small">Due ${fmtDue(t.due)}</div>` : ""}</div><button class="x" aria-label="Delete">×</button>`,
      `${t.status === "done" ? "done" : ""} prio-${t.priority}`);
    el.querySelector(".check").addEventListener("click", async () => { await api(`/api/tasks/${t.id}/toggle`, { method: "POST" }); loadTasks(); });
    el.querySelector(".x").addEventListener("click", async () => { if (confirm("Delete task?")) { await api(`/api/tasks/${t.id}`, { method: "DELETE" }); loadTasks(); } });
    list.appendChild(el);
  });
}
$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#task-input").value.trim(); if (!v) return;
  await api("/api/tasks", { method: "POST", body: { title: v } });
  $("#task-input").value = ""; loadTasks();
});
$("#show-done").addEventListener("click", () => {
  state.showDone = !state.showDone;
  $("#show-done").textContent = state.showDone ? "Hide completed" : "Show completed";
  loadTasks();
});

async function loadMemories() {
  const list = $("#memory-list");
  const mems = await api("/api/memories").catch(() => []);
  list.innerHTML = "";
  if (!mems.length) list.appendChild(li('<span class="muted">Nothing saved yet.</span>'));
  mems.forEach((m) => {
    const el = li(`<div class="grow"><div>${esc(m.fact)}</div><div class="muted small">${esc(m.category)}</div></div><button class="x" aria-label="Forget">×</button>`);
    el.querySelector(".x").addEventListener("click", async () => { await api(`/api/memories/${m.id}`, { method: "DELETE" }); loadMemories(); });
    list.appendChild(el);
  });
}

async function refreshSettings() {
  state.status = await api("/api/status").catch(() => state.status);
  const s = state.status;
  $("#model-name").textContent = s.model || "";
  const btn = $("#google-btn");
  if (!s.google_configured) { $("#google-state").textContent = "Not set up on the server (see README)"; btn.classList.add("hidden"); }
  else if (s.google_connected) { $("#google-state").textContent = "Connected ✓"; btn.textContent = "Disconnect"; btn.classList.remove("hidden"); }
  else { $("#google-state").textContent = "Not connected"; btn.textContent = "Connect"; btn.classList.remove("hidden"); }
  $("#tts-toggle").checked = state.tts;
}
$("#google-btn").addEventListener("click", async () => {
  if (state.status.google_connected) {
    if (!confirm("Disconnect Google?")) return;
    await api("/api/google/disconnect", { method: "POST" }); refreshSettings();
  } else { location.href = "/google/connect"; }
});
$("#tts-toggle").addEventListener("change", (e) => {
  state.tts = e.target.checked; save("tts", state.tts ? "1" : "0");
  if (state.tts) speak("Voice replies on.");
});
$("#logout-btn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); save("convId", null); location.reload(); });

// ---------- boot ----------
(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const g = new URLSearchParams(location.search).get("google");
  if (g) history.replaceState(null, "", "/");
  try { state.status = await api("/api/status"); } catch { state.status = { authed: false }; }
  if (!state.status.authed) {
    showLogin();
    if (state.status.configured === false) $("#login-error").textContent = "Server not set up yet: APP_PASSWORD / SECRET_KEY secrets are missing (see README).";
    return;
  }
  await showApp();
  if (g === "connected") addBubble("assistant", "✅ Google connected. I can now check your Gmail and Calendar.");
  if (g === "error") addBubble("assistant", "⚠️ Google connection was cancelled or failed.", "error");
})();
