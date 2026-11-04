# J.A.R.V.I.S.

A personal AI assistant that lives on your iPhone home screen. Powered by Claude, running on Cloudflare.

- 💬 **Chat** with streaming replies, plus 🎙️ voice input and spoken replies
- ✅ **Tasks & reminders**: "remind me to submit the BOE tomorrow at 9" (it pings your iPhone through Google Calendar)
- 🧠 **Memory**: remembers your preferences, people and projects across chats
- 📧 **Gmail**: search, read, summarize, and draft replies (it **never sends** mail; drafts wait in Gmail for you)
- 📅 **Calendar**: daily agenda, create and remove events
- 🌐 **Web search**: live rates, news and regulations, with sources
- 📲 **iPhone Shortcuts & Siri**: "Hey Siri, Ask Jarvis", a morning briefing from your Apple Calendar, native Apple Reminders, and Share-to-Jarvis. See **[docs/SHORTCUTS.md](docs/SHORTCUTS.md)**

It's a web app (PWA) that installs to your Home Screen and opens full-screen like a native app. No App Store or Mac needed.

```
iPhone (Safari / Home Screen app)
        │  HTTPS
        ▼
Cloudflare Worker (src/)  ──►  Claude API (Opus 5.5 + web search)
   │  serves the app (public/)  ──►  Google APIs (Gmail, Calendar)
   ▼
Cloudflare D1 database: chats, tasks, memory
```

Every push to `main` is deployed automatically by Cloudflare; GitHub Actions runs the tests.

---

## Setup (all from your iPhone, about 20 minutes)

Deploys are handled by **Cloudflare's GitHub integration**: every push to `main` builds and deploys automatically. Secrets live in the Cloudflare dashboard.

### 1. Claude API key
1. Open **console.anthropic.com** → sign up → **Billing**: add $5–10 credit.
2. **API Keys → Create key**. Keep it for step 4 (`ANTHROPIC_API_KEY`).

> Cost: roughly $0.01–0.05 per normal message on Opus 5.5 at medium effort. Set a monthly cap under **Billing → Limits**.

### 2. Cloudflare account
1. Sign up at **dash.cloudflare.com** (the free plan is fine) and **verify your email**. Cloudflare won't deploy Workers for unverified accounts.
2. Create the database: **Storage & Databases → D1 → Create** named `jarvis`, then put its ID in `wrangler.jsonc` → `database_id`. *(Already done for this repo.)*

### 3. Connect the repo
1. **Workers & Pages → Create → Import a repository** → authorize GitHub → choose **Jarvis**.
2. Project name `jarvis`, build command empty, deploy command `npx wrangler deploy` → **Deploy**.
3. If it shows **"Connection blocked"**, tap the ↗ next to the repo name and give the Cloudflare GitHub app access to the **Jarvis** repo.

When the build finishes, your URL is shown on the Worker's page, e.g. `https://jarvis.<your-subdomain>.workers.dev`.

### 4. Add secrets
Cloudflare dashboard → **Workers & Pages → jarvis → Settings → Variables and Secrets → Add** (type **Secret**):

| Secret | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | from step 1 |
| `APP_PASSWORD` | ✅ | the password you'll type to unlock Jarvis |
| `SECRET_KEY` | ✅ | any long random string (40+ characters); signs your login cookie |
| `SHORTCUT_TOKEN` | optional | a long random key for iPhone Shortcuts ([docs/SHORTCUTS.md](docs/SHORTCUTS.md)) |
| `GOOGLE_CLIENT_ID` | optional | step 6 |
| `GOOGLE_CLIENT_SECRET` | optional | step 6 |

Secrets take effect immediately; no redeploy needed.

### 5. Install on your iPhone
1. Open the URL in **Safari** and log in with `APP_PASSWORD`.
2. Tap **Share ⬆ → Add to Home Screen**. Jarvis now opens like an app.

**Optional: use your own domain.** **Workers & Pages → jarvis → Settings → Domains & Routes → Add → Custom domain**, e.g. `jarvis.satteches.com` (the domain must be on Cloudflare DNS).

### 6. Connect Gmail + Calendar (optional)
1. Open **console.cloud.google.com** → create a project, e.g. "Jarvis".
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen**: choose *External*, fill in the app name and your email. Under **Test users**, add your own Gmail address.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `https://YOUR-JARVIS-URL/google/callback` (and one for your custom domain if you use one)
5. Add the **Client ID** and **Client secret** as Cloudflare secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (step 4).
6. In Jarvis: **☰ → Settings → Connect**, then approve. Google will say the app is unverified; that's expected for your own private app (tap *Continue*).

> While the consent screen is in *Testing* mode, Google expires the sign-in every 7 days and you just tap Connect again. To avoid that, set the consent screen to **In production** (fine for personal use with yourself as the only user).

### Database changes
The tables in `migrations/` are already applied. If a future change adds a migration, apply it with `npx wrangler d1 migrations apply jarvis --remote` (or paste the SQL into **D1 → jarvis → Console**).

---

## Using it

- "Daily briefing": calendar + open tasks + important unread mail
- "Remind me to call the Maersk rep tomorrow 10am"
- "Remember that my manager is Ahmed and our weekly sync is Monday 9am"
- "Summarize unread emails from DP World this week and draft a reply to the latest"
- "What's the current duty on HS 8471.30 in the UAE? Cite sources."
- "Plan a 6-week learning path for Python automation with SAP exports"

**Voice:** tap 🎙️ to dictate. If the mic button doesn't appear in the Home Screen app, use the dictation mic on the iPhone keyboard. Turn on **Settings → Speak replies aloud** for hands-free mode (it auto-sends after you stop speaking).

## Costs and limits

- **Cloudflare Workers free plan:** 100k requests/day and a D1 database at no cost, which is far more than one person uses. Free Workers get about 10 ms of CPU time per request. Waiting on Claude doesn't count, but very long multi-step replies might hit it; if you see replies cut off with an "exceeded CPU" error in the Cloudflare logs, switch to **Workers Paid ($5/month)**. Check Cloudflare's pricing page for current limits.
- **Claude API:** pay per use (see step 1). Change `JARVIS_EFFORT` in `wrangler.jsonc` to `low` for cheaper, faster replies, or `high` for deeper thinking.

---

## Development

```bash
npm install
cp .dev.vars.example .dev.vars        # then fill in your keys
npx wrangler d1 migrations apply jarvis --local
npm run dev                           # http://localhost:8787
npm test                              # runs inside the Workers runtime with a local D1; Claude is faked
npm run typecheck
```

## Project layout

```
src/
  index.ts           routes: login, /api/chat (SSE stream), tasks, memory, Google OAuth
  shortcut.ts        /api/shortcut: iPhone Shortcuts / Siri endpoint (bearer key, JSON reply + actions)
  brain.ts           Claude agent loop: persona, tools, streaming, refusal fallback, error handling
  auth.ts            password login + HMAC-signed cookie
  google.ts          Google OAuth web flow, token refresh, API helper
  db.ts              D1 helpers
  env.ts             bindings and settings
  tools/
    registry.ts      tool registry + input validation
    tasks.ts         add / list / update / delete tasks
    memory.ts        remember / forget
    google.ts        Gmail search/read/draft, Calendar list/create/delete
    apple.ts         iPhone Reminders / Calendar actions (Shortcuts channel only)
docs/SHORTCUTS.md    how to build the iPhone Shortcuts
public/              the iPhone web app (HTML/CSS/JS, manifest, service worker, icons)
migrations/          D1 database schema
test/                tests (Vitest in the Workers runtime)
.github/workflows/   tests (typecheck + Vitest) on every push and PR
```

**Add a new skill:** create a tool with `defineTool({...})` in `src/tools/`, and import the file in `src/brain.ts`. Claude picks it up automatically.

## Security notes

- One user, password protected; the session cookie is HMAC-signed, HTTP-only and Secure.
- Jarvis can **draft** but not **send** email (it doesn't request the `gmail.send` scope).
- Email and web content are treated as data, not instructions (prompt-injection guard in the system prompt).
- Secrets live in Cloudflare's encrypted secret store, never in the code.
