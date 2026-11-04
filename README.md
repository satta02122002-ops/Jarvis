# J.A.R.V.I.S.

A personal AI assistant that lives on your iPhone home screen. Powered by Claude.

- 💬 **Chat** with streaming replies, plus 🎙️ voice input and spoken replies
- ✅ **Tasks & reminders**: "remind me to submit the BOE tomorrow at 9" (it pings your iPhone through Google Calendar)
- 🧠 **Memory**: remembers your preferences, people and projects across chats
- 📧 **Gmail**: search, read, summarize, and draft replies (it **never sends** mail; drafts wait in Gmail for you)
- 📅 **Calendar**: daily agenda, create and remove events
- 🌐 **Web search**: live rates, news and regulations, with sources

It's a web app (PWA) that installs to your Home Screen and opens full-screen like a native app. No App Store or Mac needed.

```
iPhone (Safari / Home Screen app)
        │  HTTPS
        ▼
FastAPI server (Docker, Railway)  ──►  Claude API (Opus 5.5 + web search)
   │  SQLite: chats, tasks, memory     ──►  Google APIs (Gmail, Calendar)
   ▼
 /data volume
```

---

## Setup (all from your iPhone, about 20 minutes)

### 1. Get a Claude API key
1. Open **console.anthropic.com** → sign up → **Billing**: add $5–10 credit.
2. **API Keys → Create key**. Copy it (starts with `sk-ant-`).

> Cost: about $0.01–0.05 per normal message on Opus 5.5 at medium effort. Set a monthly limit under **Billing → Limits**.

### 2. Deploy to Railway
1. Open **railway.com** → *Login with GitHub*.
2. **New Project → Deploy from GitHub repo → `satta02122002-ops/jarvis`**. Railway detects the `Dockerfile`.
3. Open the service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your key from step 1 |
   | `APP_PASSWORD` | the password you'll unlock Jarvis with |
   | `SECRET_KEY` | any long random string (mash the keyboard, 40+ characters) |
   | `PUBLIC_URL` | filled in at step 5 below |

4. **Settings → Volumes → Add volume**, mount path `/data`. (Without it, your tasks and memory reset on every deploy.)
5. **Settings → Networking → Generate Domain**. Copy the URL (e.g. `https://jarvis-production.up.railway.app`) into the `PUBLIC_URL` variable.

> Railway's Hobby plan is about $5/month. Any Docker host works (Render, Fly.io, a VPS); just mount persistent storage at `/data`.

### 3. Install on your iPhone
1. Open your Railway URL in **Safari** and log in with `APP_PASSWORD`.
2. Tap **Share ⬆ → Add to Home Screen**. Jarvis now opens like an app.

### 4. Connect Gmail + Calendar (optional)
1. Open **console.cloud.google.com** → create a project, e.g. "Jarvis".
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen**: choose *External*, fill in the app name and your email. Under **Test users**, add your own Gmail address.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `https://YOUR-RAILWAY-URL/google/callback`
5. Copy the **Client ID** and **Client secret** into Railway variables `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. In Jarvis: **☰ → Settings → Connect**, then approve. Google will say the app is unverified; that's expected for your own private app (tap *Continue*).

> While the consent screen is in *Testing* mode, Google expires the sign-in every 7 days and you just tap Connect again. To avoid that, set the consent screen to **In production** (fine for personal use with yourself as the only user).

---

## Using it

- "Daily briefing": calendar + open tasks + important unread mail
- "Remind me to call the Maersk rep tomorrow 10am"
- "Remember that my manager is Ahmed and our weekly sync is Monday 9am"
- "Summarize unread emails from DP World this week and draft a reply to the latest"
- "What's the current duty on HS 8471.30 in the UAE? Cite sources."
- "Plan a 6-week learning path for Python automation with SAP exports"

**Voice:** tap 🎙️ to dictate. If the mic button doesn't appear in the Home Screen app, use the dictation mic on the iPhone keyboard. Turn on **Settings → Speak replies aloud** for hands-free mode (it auto-sends after you stop speaking).

---

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY at least
export $(grep -v '^#' .env | xargs) JARVIS_DEV=1 DATA_DIR=./data PUBLIC_URL=http://localhost:8000
uvicorn app.main:app --reload
```

Tests run offline with a fake Claude client:

```bash
pip install pytest httpx && python -m pytest -q
```

## Project layout

```
app/
  main.py            FastAPI routes: login, /api/chat (SSE stream), tasks, memory, Google OAuth
  brain.py           Claude agent loop: persona, tools, streaming, refusal fallback, error handling
  config.py          env-var settings
  db.py              SQLite: conversations, messages, tasks, memories, settings
  google_auth.py     Google OAuth web flow + token refresh
  tools/
    __init__.py      tool registry + input validation
    tasks.py         add / list / update / delete tasks
    memory.py        remember / forget
    google_tools.py  Gmail search/read/draft, Calendar list/create/delete
static/              the iPhone web app (HTML/CSS/JS, manifest, service worker, icons)
tests/               offline tests
```

**Add a new skill:** write a function in `app/tools/`, decorate it with `@tool(...)`, and import the module in `app/tools/__init__.py`. Claude picks it up automatically.

## Security notes

- One user, password protected; the session cookie is HMAC-signed and HTTP-only.
- Jarvis can **draft** but not **send** email (it doesn't request the `gmail.send` scope).
- Email and web content are treated as data, not instructions (prompt-injection guard in the system prompt).
- Your Google token and data live only in your own `/data` volume.
