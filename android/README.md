# ReadLater — Android client

A self-hosted "read it later" client (in the spirit of Readwise Reader) for Android.
It syncs articles from your ReadLater companion server, caches them in a local Room
database for fully offline reading, and supports highlights, archiving, favorites,
read-position sync, and text-to-speech playback that keeps going with the screen off.

- Package: `com.readlater.app`
- minSdk 26, targetSdk/compileSdk 34
- Jetpack Compose (Material 3), Room, OkHttp, jsoup — no Retrofit, no JSON codegen

## Building

### Android Studio (recommended)

1. Open the `readlater/android` folder in Android Studio (Koala / AGP 8.5 compatible or newer).
2. Let it sync — the project uses Gradle 8.14.3, AGP 8.5.2, Kotlin 2.0.20, JDK 17.
3. Run the `app` configuration on a device or emulator (API 26+).

### Command line

An Android SDK and JDK 17 are required. Only `gradle/wrapper/gradle-wrapper.properties`
is checked in (no wrapper jar), so either use a locally installed Gradle (8.x) or
generate the wrapper first:

```sh
cd readlater/android

# Point the build at your SDK, either via env var...
export ANDROID_HOME=/path/to/android-sdk
# ...or via local.properties:
echo "sdk.dir=/path/to/android-sdk" > local.properties

# With a local Gradle install:
gradle assembleDebug

# (optional) generate the wrapper once, then use ./gradlew from then on:
gradle wrapper && ./gradlew assembleDebug
```

The debug APK lands in `app/build/outputs/apk/debug/app-debug.apk`.

## Configuring the server connection

The app is a client of the ReadLater companion server (the same one the ReadLater
Firefox extension saves articles to).

1. Open the app → the toolbar → **Settings**.
2. Enter the **Server URL** (e.g. `http://192.168.1.10:8090` — plain HTTP on a LAN
   is allowed; cleartext traffic is enabled) and your **Access token**. Any trailing
   slash is trimmed automatically.
3. Tap **Test connection** — it calls `GET /api/health` and reports the result.
4. Go back to the list and tap the refresh icon to sync. Articles saved with the
   Firefox extension appear in the Inbox; everything is cached locally, so the app
   stays fully usable offline. Local changes (archive, favorite, read position,
   highlights) are pushed opportunistically and re-pushed on the next sync if you
   were offline.

## Notifications and listening with the screen off

- On Android 13+ the app asks for the **notification permission** at first launch.
  Granting it lets the read-aloud media notification (play/pause/skip controls)
  appear; playback itself works either way.
- Text-to-speech runs in a **foreground service** (`mediaPlayback` type) that holds
  a partial wake lock, so an article keeps being read aloud after you turn the
  screen off. Control it from the notification, from a Bluetooth headset (media
  session), or from the reader's bottom bar (play/pause, previous/next paragraph,
  speech rate 0.5×–2.0×). The spoken paragraph is highlighted and followed in the
  reader, and the read position is saved as it advances.

## Read position

Your place in every article is saved automatically and synced to the server:

- While scrolling, the position is persisted continuously (debounced ~1s,
  written locally so it survives the app being killed mid-read; it is pushed
  to the server on the next sync or pushing save).
- Leaving the reader pushes the position to the server immediately.
- During text-to-speech the spoken paragraph is saved as playback advances,
  and pause/stop/end-of-article push it to the server.

Reopening an article scrolls straight back to where you left off, and the
article list shows an "In progress" marker with the paragraph you reached.

## Highlighting

Long-press any paragraph in the reader to open the highlight sheet: trim the
pre-filled text to the sentence you want, optionally add a note, and save. Or use
"Play from here" to start text-to-speech at that paragraph. Highlighted paragraphs are tinted
(exact substrings are highlighted inline); tap one to view or delete its
highlights. The Highlights screen collects all highlights across articles and can
export them to the clipboard as Markdown.
