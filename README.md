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

Every account also gets a private **email address** (shown in Settings) —
mail sent there lands in the inbox as an article. Enable it by pointing an
inbound-email provider (Postmark works well) at the webhook:

1. Set `READLATER_INBOUND_SECRET=<random>` and
   `READLATER_INBOUND_DOMAIN=in.yourdomain.com` on the server.
2. Add an MX record: `in.yourdomain.com → inbound.postmarkapp.com` (prio 10).
3. In Postmark, set the inbound webhook URL to
   `https://your-server/api/inbound-email?secret=<that secret>` and the
   inbound domain to `in.yourdomain.com`.

Delivery is idempotent per message, HTML bodies are sanitized, and mail to
unknown aliases is dropped. Regenerate your address in Settings if it ever
starts collecting spam.

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
   ReadLater*, or **Alt+T**.

### Why this beats paywalls

The extension never re-downloads the page. It reads the **DOM currently
rendered in your tab** — after your login, your metered-access cookie, and all
client-side rendering have done their work — cleans out navigation/ads/forms,
and ships that HTML to your server. If you can read it, you can save it.

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
| `GET /api/articles?q=…&domain=…&highlighted=1` | Search (all terms AND-matched vs title/author/site/text; domain matches subdomains; `email` = emailed-in) |
| `GET /api/articles/{id}` | Full article incl. HTML |
| `PATCH /api/articles/{id}` | Update `archived` / `favorite` / `readParagraph` |
| `DELETE /api/articles/{id}` | Delete article + its highlights |
| `GET/POST /api/articles/{id}/highlights` | List / add highlights (idempotent via `clientId`) |
| `GET /api/highlights` | All highlights with article titles |
| `GET /api/highlights/export.md` | Markdown export of all highlights |
| `DELETE /api/highlights/{id}` | Remove a highlight |
