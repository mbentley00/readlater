# ReadLater — self-hosted read-it-later (Readwise Reader clone)

Save articles from Firefox — **exactly as rendered in your browser session, so
paywalled content you can see gets saved** — and read them in a native Android
app with offline storage, one-gesture highlighting, and text-to-speech that
keeps reading with the screen off.

```
┌──────────────────┐   POST article    ┌──────────────────┐   sync (pull/push)   ┌──────────────────┐
│ Firefox extension │ ────────────────▶ │   sync server    │ ◀──────────────────▶ │   Android app    │
│ (captures the     │                   │ (zero-dep Node,  │                      │ (Compose, Room,  │
│  live DOM)        │                   │  JSON storage)   │                      │  TTS service)    │
└──────────────────┘                   └──────────────────┘                      └──────────────────┘
```

## Components

| Directory | What it is |
|---|---|
| [`server/`](server/) | Node.js sync server on SQLite (accounts, articles + highlights, full-text search, bearer-token auth, built-in web reader) |
| [`firefox-extension/`](firefox-extension/) | Firefox add-on that extracts the article from the current page render and pushes it to the server |
| [`android/`](android/) | Kotlin / Jetpack Compose reader app with offline cache, highlights, and screen-off TTS |

## 1. Run the server

Needs Node.js ≥ 18. One dependency (`better-sqlite3` — storage + full-text
search); data lives in a single SQLite file, and an existing `db.json` from
older versions is imported automatically on first start.

```sh
cd server
npm install
node server.js
```

Then open `http://localhost:8090/signup` in a browser and create an account.
Every account has its own articles, highlights, and **API token** — find the
token on the **Settings** page and enter it in the Firefox extension and the
Android app. Set `READLATER_ALLOW_SIGNUP=0` once everyone you want has an
account. Other env overrides: `PORT`, `READLATER_DATA_DIR`.

The server doubles as a **web reader**: log in to browse your inbox /
favorites / archive, read articles (highlights are marked inline; select any
text to add a new one), archive/favorite from the reader, search everything
(full text, with domain and has-highlights filters), browse and export
highlights, and manage your API token.

### Email articles in (newsletters)

Forward a newsletter to a mailbox and it shows up in your list. There are two
ways to wire this up; pick one.

**IMAP polling (no mail provider, single account).** The server logs into one
mailbox every couple of minutes and saves each new message as an article for
one account. Nothing to pay for, no MX record, no webhook.

```
# the mailbox to sign into (mail plumbing)
READLATER_IMAP_HOST=mail.yourdomain.com    # required to enable
READLATER_IMAP_USER=read@yourdomain.com    # required
READLATER_IMAP_PASS=…                      # required — keep it in a secret

# NOT a mail setting: the Earmark username whose library the mail lands in
READLATER_IMAP_SAVE_TO_EARMARK_USER=michael   # required

READLATER_IMAP_ALLOW_FROM=you@gmail.com    # optional sender allowlist
READLATER_IMAP_PORT=993                    # optional
READLATER_IMAP_MAILBOX=INBOX               # optional
READLATER_IMAP_INTERVAL=120                # optional, seconds
```

Messages are marked read once saved, so each is processed once; the article's
`email:<Message-ID>` URL means even a lost flag can't create a duplicate.
`Fwd:` prefixes are stripped from the title. `ALLOW_FROM` matches the `From:`
header — it keeps stray mail out of your reader, but headers are forgeable, so
it is not a security boundary. Keep the address private.

**Inbound webhook (per-account aliases, needs a provider).** Every account gets
a private alias (shown in Settings); an inbound-email provider POSTs parsed mail
to the server. Note that *forwarded* mail does not work here — routing is by
recipient alias, and a forward's recipient is the mailbox, not your alias.

1. Set `READLATER_INBOUND_SECRET=<random>` and
   `READLATER_INBOUND_DOMAIN=in.yourdomain.com` on the server.
2. Add an MX record: `in.yourdomain.com → inbound.postmarkapp.com` (prio 10).
3. In Postmark, set the inbound webhook URL to
   `https://your-server/api/inbound-email?secret=<that secret>` and the
   inbound domain to `in.yourdomain.com`.

Both paths are idempotent per message, sanitize HTML bodies, and queue TTS
audio like any other save. If both are configured, Settings shows the IMAP
mailbox.

**From Gmail on Android:** to save a *link* inside an email, long-press it →
Share → Earmark. To save the email itself, forward it to the mailbox above.

### Skipping boilerplate

Newsletters and importers leave the same junk in every article — "Sign up for
the latest from our newsletter", "Some content from the original document could
not be imported". Add a **skip rule** and paragraphs containing that phrase are
dropped from articles as they are saved.

Every route opens the phrase in an editable box, prefilled with the text you
pointed at, so you can trim it to the part that actually repeats before
committing:

- **Web reader** — select the text and click **Never import**; or click an
  existing highlight and choose **Never import** from its menu.
- **Android reader** — long-press the paragraph, trim the text field, then
  **Never import this text again**.
- **Settings → Skipped text** — type a phrase directly.

Settings shows how many times each rule has fired, so a rule that never matches
is easy to spot and delete.

Rules apply to **future saves only** — every save path (extension, save-by-URL,
LLM rescue, PDF import, emailed newsletters), but never to an article already
in your library. That is deliberate: highlights, reading position and the TTS
position are all stored as indices into the article's paragraph sequence, so
removing a paragraph from a saved article would silently re-anchor every
highlight after it.

Two guardrails. A phrase must be at least 8 characters, so a stray word cannot
gut every article. And a rule will not delete a paragraph longer than 600
characters: when boilerplate appears mid-essay, leaving one stray sentence is
better than destroying three paragraphs of real prose. Adding a rule reports
how many already-saved articles contain the phrase, which makes an over-broad
rule obvious before it starts affecting future saves.

### Backups

Fly snapshots the data volume daily with 5-day retention. That covers disk
failure; it does not cover deleting something and noticing next week, and the
snapshots live in the same Fly account as the data. For a copy you control:

```bash
export EARMARK_TOKEN="<API token from /settings>"
./server/backup.sh ~/earmark-backups
```

Cron it daily. Each run writes `earmark-<timestamp>.ndjson.gz` and prunes
anything older than `EARMARK_BACKUP_KEEP_DAYS` (default 30). Before storing, it
checks the header counts, the `end` trailer, and the lines actually received —
every line of a truncated NDJSON file parses on its own, so the trailer is the
only thing that distinguishes a complete backup from half of one. It also
refuses to write a zero-article backup over existing ones.

Use `export.ndjson`, not `export.json`, for anything large. A full account
serialized as a single JSON document cannot be read back: V8 caps strings at
~536M characters and a real account exceeds that. NDJSON streams both ways —
a 20k-article backup restores in ~14MB of heap.

Read one back:

```bash
gzip -dc earmark-20260709T033000Z.ndjson.gz | head -1   # header: counts, views
gzip -dc earmark-20260709T033000Z.ndjson.gz | tail -1   # trailer: rows written
```

The Android app also keeps a full local copy of articles and highlights, but
it is a sync replica, not a backup — deletions propagate to it.

Upgrading from the old single-token version: the first account created adopts
the existing token (from `READLATER_TOKEN` or `data/token.txt`) and all
existing articles, so already-configured devices keep working.

Put the server somewhere both your desktop and phone can reach. If exposed to
the internet, put it behind HTTPS (Caddy/nginx reverse proxy) — or just use
fly.io:

```sh
cd server
fly launch --no-deploy --copy-config   # first time: creates the app
fly volumes create readlater_data --region <region> --size 1
fly deploy --ha=false
```

(`server/fly.toml` is checked in; article data lives on the persistent volume
mounted at `/data`.)

Run the test suite with `node test.js`.

## 2. Install the Firefox extension

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   pick `firefox-extension/manifest.json`.
   (For a permanent install, zip the folder contents and sign it via
   [addons.mozilla.org](https://addons.mozilla.org/developers/) as an unlisted
   add-on, or use Firefox Developer Edition with `xpinstall.signatures.required=false`.)
2. Open the extension's **Settings** and enter your server URL + token, then
   **Test connection**.
3. Save any article via the toolbar button, right-click → *Save page to
   Earmark*, or **Alt+D** (the toolbar tooltip shows whatever key is actually
   bound, so a rebind in `about:addons` stays discoverable).

### Why this beats paywalls

The extension never re-downloads the page. It reads the **DOM currently
rendered in your tab** — after your login, your metered-access cookie, and all
client-side rendering have done their work — and ships that HTML to your
server. If you can read it, you can save it.

### How articles are parsed

1. **Mozilla Readability** (the Firefox Reader View engine, vendored) extracts
   the article from a clone of the rendered DOM.
2. If that fails or comes back thin, a **container-scoring heuristic** takes
   over (text-densest container, discounted by link density, noise stripped).
3. If the result still looks wrong — tiny, or a small fraction of the page's
   visible text — the extension attaches a stripped copy of the page and the
   server **re-extracts it with a cheap LLM** (Claude Haiku) in the background,
   upgrading the stored article a few seconds later. Enable this by setting
   `ANTHROPIC_API_KEY` on the server; without it, step 3 is skipped. Rescues
   cost roughly $0.02–0.05 each.

## 3. Build & install the Android app

See [`android/README.md`](android/README.md). Short version: open
`android` in Android Studio and run it, or:

```sh
cd android
ANDROID_HOME=/path/to/sdk gradle assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

In the app, open **Settings**, enter the same server URL + token, tap **Test
connection**, then sync from the article list.

### Reading features

- **Offline first** — articles sync into a local Room database; read anywhere.
- **Highlights** — long-press any paragraph → trim the text if you want → save.
  Highlighted passages render marked in the article; browse/export everything
  from the Highlights screen (Markdown to clipboard, or
  `GET /api/highlights/export.md` on the server).
- **Listen with the screen off** — the play button starts a foreground
  media service that speaks the article paragraph-by-paragraph with Android's
  TTS engine, holds a wake lock, shows lock-screen media controls, tracks your
  position, and keeps going when the display sleeps. Speed is adjustable
  (0.5×–2×).
- Read position, archive state, and favorites sync back to the server.

## API (for your own tooling)

All endpoints under `/api` require `Authorization: Bearer <token>` (each
account's token is on its Settings page; the web UI's session cookie also
works). Timestamps are epoch milliseconds.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Connectivity check (per-account counts) |
| `GET /api/me` | Current account (username, API token, email-in address) |
| `POST /api/inbound-email?secret=…` | Inbound-email webhook (Postmark JSON; not bearer-authed) |
| `POST /api/articles` | Save/update an article (`{url, title, html, ...}`, deduped by URL) |
| `GET /api/articles?includeArchived=1` | List article metadata (no HTML) |
| `GET /api/articles?q=…&domain=…&highlighted=1&minWords=…&maxWords=…&minHighlights=…` | Search + filters (terms AND-matched vs title/author/site/text; domain matches subdomains; `email` = emailed-in) |
| `GET/POST /api/views`, `DELETE /api/views/{id}` | Saved filter views (shown as tabs in web + Android) |
| `GET/POST /api/skip-rules`, `DELETE /api/skip-rules/{id}` | Boilerplate phrases dropped from future saves |
| `POST /api/import/pdf?filename=…` | Import a PDF (raw body); text extracted into an article |
| `GET /api/export.json` | Full export as one JSON document: articles (with HTML), highlights, views |
| `GET /api/export.ndjson` | Same data, line-delimited — **use this for backups** (see below) |
| `POST /api/app.apk`, `GET /app.apk` | Upload / download the Android app build |
| `GET /api/articles/{id}` | Full article incl. HTML |
| `PATCH /api/articles/{id}` | Update `archived` / `favorite` / `readParagraph` |
| `DELETE /api/articles/{id}` | Delete article + its highlights |
| `GET/POST /api/articles/{id}/highlights` | List / add highlights (idempotent via `clientId`) |
| `GET /api/highlights` | All highlights with article titles |
| `GET /api/highlights/export.md` | Markdown export of all highlights |
| `DELETE /api/highlights/{id}` | Remove a highlight |
