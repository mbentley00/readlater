# ReadLater Firefox extension

Saves the current page to your ReadLater server **from the live DOM** — the
page exactly as rendered in your session (after login / metered paywall
cookies / client-side rendering) — rather than re-fetching the URL.

## Install (development)

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `manifest.json`.
2. Extension **Settings** → enter server URL + API token → **Test connection** → **Save**.

## Use

- Toolbar button → **Save this page**
- Right-click → **Save page to ReadLater**
- Keyboard: **Alt+Shift+S**

A notification confirms the save; the article then appears in the Android app
on next sync.

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
