# JARVIS × iPhone Shortcuts

Talk to Jarvis through Siri, get a morning briefing with your **Apple Calendar**, and have it create **real Apple Reminders and Calendar events**: native alerts that sync to your Watch and Mac.

How it works: a Shortcut sends your message to `https://YOUR-JARVIS-URL/api/shortcut` with a private key. Jarvis answers in plain text plus a list of reminders/events, and the Shortcut creates them with Apple's own actions.

You build 4 shortcuts (about 15 minutes, all on the iPhone):

| Shortcut | Use |
|---|---|
| **Ask Jarvis** | The core one. "Hey Siri, Ask Jarvis" → speak → Jarvis answers and sets any reminders/events. The others call this one. |
| **Jarvis Briefing** | Reads today's calendar and asks Jarvis for your daily briefing. Run it from an automation every morning. |
| **Share to Jarvis** | From the share sheet in Mail, WhatsApp, Safari or Files: "summarize", "extract the BL / container details", "make tasks". |
| *(Automations)* | Run the briefing at 7:30 am; show priorities when you arrive at JAFZA. |

---

## Step 0: Create your Shortcut key

1. Make a long random key. The easiest way: **Settings → Passwords → +**, then copy the **suggested strong password**. Save it there as "Jarvis Shortcut key" so you can find it again.
2. Cloudflare dashboard → **Workers & Pages → jarvis → Settings → Variables and Secrets → Add** → type **Secret**, name **`SHORTCUT_TOKEN`**, value = your key → **Deploy**.
3. You'll test the key in Shortcut 1 below.

> Anyone with this key can talk to your Jarvis, so treat it like a password. To revoke it, change the secret in Cloudflare and update the shortcut.

---

## Shortcut 1: "Ask Jarvis" (core)

Shortcuts app → **+** → name it **Ask Jarvis** (this is also the Siri phrase). Add these actions in order:

1. **If** **Shortcut Input** *has any value*
   - **Get Text from Input** (Shortcut Input)
   **Otherwise**
   - **Ask for Input**: Input Type *Text*, Prompt `What do you need?`
   **End If**

   *(This lets the other shortcuts pass text in, and asks you when you run it yourself or through Siri.)*
2. **Set Variable**: name `Message`, value **If Result**.
3. **Get Contents of URL**
   - URL: `https://YOUR-JARVIS-URL/api/shortcut`
   - Tap **Show More**:
     - Method: **POST**
     - Headers → **Add new header**: key `Authorization`, value `Bearer YOUR_SHORTCUT_KEY` (the word *Bearer*, a space, then your key)
     - Request Body: **JSON** → **Add new field** → *Text*: key `message`, value variable **Message**
4. **Get Dictionary Value**: Get **Value** for key `reminders` in **Contents of URL**
5. **Repeat with Each** item in **Dictionary Value**:
   1. **Get Dictionary Value**: `title` in **Repeat Item** → **Set Variable** `RTitle`
   2. **Get Dictionary Value**: `due` in **Repeat Item** → **Set Variable** `RDue`
   3. **If** `RDue` **has any value**:
      - **Add New Reminder**: `RTitle`, tap to expand → **Alert** = *On Date* → `RDue`
   4. **Otherwise**:
      - **Add New Reminder**: `RTitle`
   5. **End If**
6. **End Repeat**
7. **Get Dictionary Value**: `events` in **Contents of URL**
8. **Repeat with Each** item in **Dictionary Value**:
   1. **Get Dictionary Value** `title` in **Repeat Item** → **Set Variable** `ETitle`
   2. **Get Dictionary Value** `start` in **Repeat Item** → **Set Variable** `EStart`
   3. **Get Dictionary Value** `end` in **Repeat Item** → **Set Variable** `EEnd`
   4. **Get Dictionary Value** `location` in **Repeat Item** → **Set Variable** `ELocation`
   5. **Add New Event**: Title `ETitle`, Start Date `EStart`, End Date `EEnd`, Location `ELocation` (pick your calendar)
9. **End Repeat**
10. **Get Dictionary Value**: `reply` in **Contents of URL**
11. **Show Result**: **Dictionary Value** (Siri reads it aloud when you use voice)

**Try it:** run it and type `ping`, then try `Remind me to call the Maersk rep tomorrow at 10am`. A new reminder should appear in the Reminders app.

### Siri
Say **"Hey Siri, Ask Jarvis"**. Siri asks "What do you need?", you answer, and Siri speaks the reply. Rename the shortcut to change the phrase (e.g. "Jarvis").

---

## Shortcut 2: "Jarvis Briefing"

1. **Find Calendar Events** where **Start Date** *is today*, sorted by Start Date (oldest first).
2. **Repeat with Each** item in **Calendar Events**:
   - **Text**: `Repeat Item.Start Date (format: Time only) – Repeat Item.Title @ Repeat Item.Location`
3. **End Repeat**
4. **Combine Text**: **Repeat Results** with **New Lines**
5. **Text**:
   ```
   Give me my daily briefing: today's calendar, my open Jarvis tasks, and anything I should prepare for. Keep it short.
   <calendar>
   [Combined Text]
   </calendar>
   ```
6. **Run Shortcut**: **Ask Jarvis**, input = **Text**.

Your iPhone calendar includes any Google, Outlook or Exchange calendars you've added under **Settings → Calendar → Accounts**, so work meetings show up too.

---

## Shortcut 3: "Share to Jarvis"

1. Tap the **ⓘ** → turn on **Show in Share Sheet**, input types: *Text, Safari web pages, URLs, PDFs, Articles*.
2. **Get Text from Input** (Shortcut Input)
3. **Choose from Menu**, prompt `Jarvis, please…`, options:
   - `Summarize this` → **Text** `Summarize this in a few lines.`
   - `Extract shipment details` → **Text** `Extract shipment details (BL/AWB, container numbers, ETA/ETD, ports, consignee, HS codes, amounts) as a short list.`
   - `Make tasks` → **Text** `Turn the action items in this into Jarvis tasks and iPhone reminders where there's a deadline.`
   - `Draft a reply` → **Text** `Draft a short professional reply to this.`
4. **End Menu**
5. **Text**:
   ```
   [Menu Result]
   <shared>
   [Text from step 2]
   </shared>
   ```
6. **Run Shortcut**: **Ask Jarvis**, input = **Text**

Now in Mail/WhatsApp/Safari: **Share → Share to Jarvis**.

---

## Automations

Shortcuts → **Automation** → **+ / New Automation**:

| Trigger | Do | Setting |
|---|---|---|
| **Time of Day** 7:30 AM, Weekdays | Run Shortcut **Jarvis Briefing** | **Run Immediately**, Notify When Run off |
| **Arrive** at your JAFZA office | Run Shortcut **Ask Jarvis** with input `I just arrived at the office. What are my top 3 priorities today?` | Run Immediately |
| **Leave** work | Run Shortcut **Ask Jarvis** with input `Workday's over. Anything still open today, and what should I tackle first tomorrow?` | Run Immediately |

For an automation, the reply appears as a notification via **Show Result**. To get a banner instead, use **Show Notification** with the reply.

---

## Reference: the API

`POST /api/shortcut`
Headers: `Authorization: Bearer <SHORTCUT_TOKEN>`, `Content-Type: application/json` (a plain-text body also works)

```json
{ "message": "remind me to call Maersk tomorrow at 9", "new_conversation": false }
```

Response:

```json
{
  "reply": "Reminder set for 9 AM tomorrow: call Maersk.",
  "reminders": [{ "title": "Call Maersk", "notes": "", "due": "November 5, 2026 at 9:00 AM", "due_iso": "2026-11-05T09:00+04:00" }],
  "events": [],
  "conversation_id": 12
}
```

- `GET /api/shortcut` with the same header returns `{"ok": true, "reply": "Connected…"}`, a quick way to test the key.
- Messages from Shortcuts on the same day share one conversation (shown as "Siri · 5 Nov" in the app), so follow-ups like "make it 10 instead" work. Send `"new_conversation": true` to start fresh.
- Shortcut requests use effort `low` for speed. Change it with the `JARVIS_SHORTCUT_EFFORT` variable in `wrangler.jsonc`.
- Errors still return HTTP 200 with a spoken `reply` ("Sorry, something went wrong: …"), so Siri tells you what happened. Only a wrong or missing key (401), an empty message (400) and a missing `SHORTCUT_TOKEN` (503) return errors.

## Troubleshooting

- **"Wrong or missing Shortcut key"**: the header must be exactly `Authorization` = `Bearer <key>` (one space), and the key must match `SHORTCUT_TOKEN` in Cloudflare.
- **"Shortcuts aren't set up yet"**: add the `SHORTCUT_TOKEN` secret (step 0).
- **Reminder created without an alert**: check the reminder's **Alert** is set to **On Date** with `RDue`.
- **Shortcut times out on long requests**: ask for less at once, or keep `JARVIS_SHORTCUT_EFFORT` at `low`.
