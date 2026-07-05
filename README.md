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
| [`server/`](server/) | Zero-dependency Node.js sync server (articles + highlights, bearer-token auth) |
| [`firefox-extension/`](firefox-extension/) | Firefox add-on that extracts the article from the current page render and pushes it to the server |
| [`android/`](android/) | Kotlin / Jetpack Compose reader app with offline cache, highlights, and screen-off TTS |

## 1. Run the server

Needs Node.js ≥ 18. No `npm install` required.

```sh
cd server
node server.js
```

On first start it prints the URL and a generated **API token** (also stored in
`data/token.txt`). Put the server somewhere both your desktop and phone can
reach — a home server, a Raspberry Pi, or a VPS. Override defaults with
`PORT`, `READLATER_TOKEN`, and `READLATER_DATA_DIR` environment variables.

If exposed to the internet, put it behind HTTPS (Caddy/nginx reverse proxy).

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
   ReadLater*, or **Alt+Shift+S**.

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

All endpoints under `/api` require `Authorization: Bearer <token>`.
Timestamps are epoch milliseconds.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Connectivity check |
| `POST /api/articles` | Save/update an article (`{url, title, html, ...}`, deduped by URL) |
| `GET /api/articles?includeArchived=1` | List article metadata (no HTML) |
| `GET /api/articles/{id}` | Full article incl. HTML |
| `PATCH /api/articles/{id}` | Update `archived` / `favorite` / `readParagraph` |
| `DELETE /api/articles/{id}` | Delete article + its highlights |
| `GET/POST /api/articles/{id}/highlights` | List / add highlights (idempotent via `clientId`) |
| `GET /api/highlights` | All highlights with article titles |
| `GET /api/highlights/export.md` | Markdown export of all highlights |
| `DELETE /api/highlights/{id}` | Remove a highlight |
