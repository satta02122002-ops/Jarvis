# J.A.R.V.I.S.

A personal AI assistant that lives on your iPhone home screen. Powered by Claude, running on Cloudflare.

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
Cloudflare Worker (src/)  ──►  Claude API (Opus 5.5 + web search)
   │  serves the app (public/)  ──►  Google APIs (Gmail, Calendar)
   ▼
Cloudflare D1 database: chats, tasks, memory
```

Every push to `main` is tested and deployed automatically by GitHub Actions.

---

## Setup (all from your iPhone, about 20 minutes)

You'll collect a few keys and paste them into **GitHub → your repo → Settings → Secrets and variables → Actions → New repository secret**.

### 1. Claude API key → `ANTHROPIC_API_KEY`
1. Open **console.anthropic.com** → sign up → **Billing**: add $5–10 credit.
2. **API Keys → Create key**. Save it as the GitHub secret `ANTHROPIC_API_KEY`.

> Cost: roughly $0.01–0.05 per normal message on Opus 5.5 at medium effort. Set a monthly cap under **Billing → Limits**.

### 2. Your login → `APP_PASSWORD` and `SECRET_KEY`
- `APP_PASSWORD`: the password you'll type to unlock Jarvis.
- `SECRET_KEY`: any long random string (mash the keyboard, 40+ characters). It signs your login cookie.

### 3. Cloudflare → `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
1. Sign up at **dash.cloudflare.com** (the free plan is fine).
2. **Account ID:** on the dashboard home, open **Workers & Pages**; the Account ID is shown in the right-hand panel (or in the URL after `dash.cloudflare.com/`). Save it as `CLOUDFLARE_ACCOUNT_ID`.
3. **API token:** profile icon → **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template.
   - Under **Permissions**, also add **Account → D1 → Edit**.
   - Account Resources: your account. Zone Resources: *All zones* (or just satteches.com).
   - **Create Token**, then save it as `CLOUDFLARE_API_TOKEN`.

### 4. Deploy
In GitHub: **Actions → Test & deploy → Run workflow** (or just push to `main`). The first run creates the D1 database, sets it up, and deploys. When it finishes, the log shows your URL, e.g. `https://jarvis.<your-subdomain>.workers.dev`.

### 5. Install on your iPhone
1. Open the URL in **Safari** and log in with `APP_PASSWORD`.
2. Tap **Share ⬆ → Add to Home Screen**. Jarvis now opens like an app.

**Optional: use your own domain.** Cloudflare dashboard → **Workers & Pages → jarvis → Settings → Domains & Routes → Add → Custom domain**, e.g. `jarvis.satteches.com` (the domain must be on Cloudflare DNS).

### 6. Connect Gmail + Calendar (optional)
1. Open **console.cloud.google.com** → create a project, e.g. "Jarvis".
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen**: choose *External*, fill in the app name and your email. Under **Test users**, add your own Gmail address.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `https://YOUR-JARVIS-URL/google/callback` (and one for your custom domain if you use one)
5. Save the **Client ID** and **Client secret** as GitHub secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then re-run the workflow (**Actions → Test & deploy → Run workflow**).
6. In Jarvis: **☰ → Settings → Connect**, then approve. Google will say the app is unverified; that's expected for your own private app (tap *Continue*).

> While the consent screen is in *Testing* mode, Google expires the sign-in every 7 days and you just tap Connect again. To avoid that, set the consent screen to **In production** (fine for personal use with yourself as the only user).

### Secrets checklist

| GitHub secret | Required | From |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | step 3 |
| `ANTHROPIC_API_KEY` | ✅ | step 1 |
| `APP_PASSWORD` | ✅ | step 2 |
| `SECRET_KEY` | ✅ | step 2 |
| `GOOGLE_CLIENT_ID` | optional | step 6 |
| `GOOGLE_CLIENT_SECRET` | optional | step 6 |

Changing a secret takes effect on the next deploy (re-run the workflow).

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
public/              the iPhone web app (HTML/CSS/JS, manifest, service worker, icons)
migrations/          D1 database schema
test/                tests (Vitest in the Workers runtime)
scripts/             CI deploy helper
.github/workflows/   test & deploy pipeline
```

**Add a new skill:** create a tool with `defineTool({...})` in `src/tools/`, and import the file in `src/brain.ts`. Claude picks it up automatically.

## Security notes

- One user, password protected; the session cookie is HMAC-signed, HTTP-only and Secure.
- Jarvis can **draft** but not **send** email (it doesn't request the `gmail.send` scope).
- Email and web content are treated as data, not instructions (prompt-injection guard in the system prompt).
- Secrets live in GitHub Actions secrets and Cloudflare's encrypted secret store, never in the code.
