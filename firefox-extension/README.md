# ReadLater Firefox extension

Saves the current page to your ReadLater server **from the live DOM** — the
page exactly as rendered in your session (after login / metered paywall
cookies / client-side rendering) — rather than re-fetching the URL.

## Install (development)

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `manifest.json`.
2. Extension **Settings** → enter server URL + API token → **Test connection** → **Save**.

## Use

- Toolbar button → **Save this page**
- Right-click a page → **Save page to Earmark**
- Right-click a link → **Save link to Earmark** (the server fetches the target)
- Keyboard: **Alt+D** (the toolbar tooltip shows whatever key is actually bound)

The toolbar icon is the primary feedback: **…** while saving, then **✓** or
**!**. Notifications are secondary and coalesced — saving twenty tabs raises one
"Saved 20 articles to Earmark" toast once the burst stops, not twenty toasts.
Failures batch the same way, deduplicated by reason. Each kind reuses a fixed
notification id, so a new one replaces the old rather than queueing behind it.

Options → **Notifications**: one summary per batch (default), only on failure,
or never. The article appears in the Android app on the next sync.

Note: `Alt+{F,E,V,S,B,T,H}` are Firefox's menubar access keys (File, Edit, View,
History, Bookmarks, Tools, Help). Firefox swallows those before the extension
sees them, and the match ignores Shift — so `Alt+T` and `Alt+Shift+S` both fail
silently. Pick a letter outside that set.

## Publish an update

`./publish.sh` signs the extension (Mozilla "unlisted") and uploads the `.xpi` to
the server, which advertises it at `/extension/updates.json` so installed copies
auto-update.

```sh
export AMO_KEY="user:XXXXXXXX:XX"   # addons.mozilla.org → Developer Hub → API Keys
export AMO_SECRET="<64-hex secret>"
export EARMARK_TOKEN="<API token from /settings>"

./publish.sh            # bump the patch version if needed, sign, upload, verify
./publish.sh 1.1.0      # publish an explicit version
./publish.sh --check    # is the tree what browsers actually run? (no creds needed)
```

**Don't bump `manifest.json` by hand — the script owns the version.** Bumping and
publishing used to be separate steps, and they drifted: the tooltip-shortcut
feature sat committed in the tree while every browser kept running the older
signed build, because the manifest had been bumped but nothing was ever signed.
Editing the code is not shipping it; only `publish.sh` is. The script bumps past
whatever is already published (Mozilla rejects re-signing an existing version),
verifies `updates.json` actually serves the new build afterwards, and reminds you
to commit the bump.

`--check` is the cheap way to catch drift — it compares the manifest against what
the server publishes and exits non-zero if they differ.

## Files

| File | Role |
|---|---|
| `extractor.js` | Content script: picks the article container from the rendered DOM, strips nav/ads/forms/scripts, absolutizes links and lazy-loaded images, returns `{url, title, byline, siteName, excerpt, html, textContent}` |
| `background.js` | Runs the extractor on demand, POSTs the result to `{server}/api/articles`, shows notifications, wires the context menu and keyboard shortcut |
| `popup.html/js` | Toolbar popup with the save button |
| `options.html/js` | Server URL + token settings with connection test |

Permissions are minimal: `activeTab` (read the page only when you invoke the
extension), `storage`, `contextMenus`, `notifications`. Your server must allow
CORS (the bundled server does).
