# Task packet 5: open shared phone files without copying them (owner: agy, reviewer: Codex or pi)

Research: `docs/research/native-streaming.md` (hermes). Android only in this packet; iOS keeps its copy until it can be tested on a Mac/CI.

## Problem

`MainActivity` copies every "Open with" / Share file (up to 2 GB) into the cache before the page can read it. Large videos take long to open and the copy doubles storage.

## Design (CTO decision)

Hold the provider's file open and read ranges on demand. VIEW/SEND grants cannot be persisted, so the handle is opened while the grant is live and kept for the life of the tab.

### Contract between native and page (both sides must follow it exactly)

1. Native registers a file and calls in the page:
   `window.__univiewOpenShared(token, name, size, mime)`. If the function does not exist yet, push `{token, name, size, mime}` onto `window.__univiewPendingShared` (created if missing). `token` is 32 lowercase hex characters (128 random bits). `size` is the byte length from `ParcelFileDescriptor.getStatSize()`.
2. The page reads bytes with
   `GET {localUrl}/_uniview_shared/{token}?start={n}&end={m}` (same origin; `localUrl` is `https://localhost` on Android).
   - 200 with `Content-Type: application/octet-stream` and the bytes `[start, min(end, size))`. No `Range` header is used, which avoids Chromium issue 40739128.
   - At most 8 MiB per request (`end - start <= 8388608`), else 400.
   - Missing, non-numeric, negative or reversed bounds: 400. `start >= size`: 200 with an empty body.
   - Unknown token: 404.
3. The page releases a file with `GET {localUrl}/_uniview_shared/{token}?close=1` → 204; the native side closes the descriptor and forgets the token.
4. Media (`<video>`, `<audio>`) keeps using the existing service-worker stream (`src/remote/stream.ts`), which turns Range requests into `readRange` calls, so no native Range handling is needed.

### Android (packet 5a)

- New pure helper `android/app/src/main/java/com/uniview/viewer/SharedRange.java` that parses and validates `start`/`end`/`close` from a query string against a known size and the 8 MiB cap, returning a small result object (status code, start, end, close flag). Unit-test it with JUnit in `android/app/src/test/java/com/uniview/viewer/SharedRangeTest.java`.
- New `SharedFiles.java`: a thread-safe registry `token → {ParcelFileDescriptor, FileChannel, size, name}` with `register(...)` (returns the token), `read(token, start, end)` (positional `FileChannel.read(ByteBuffer, position)`), `close(token)` and `closeAll()`. At most 64 open files (closing the oldest), and tokens from `SecureRandom`.
- `MainActivity`: in `deliver`, first try `openFileDescriptor(uri, "r")`. If it succeeds and `getStatSize() >= 0` and the channel is seekable, register it and post the `__univiewOpenShared` script (with the same JSON quoting and the page-loaded queue as today). Otherwise, fall back to the existing copy path unchanged. Call `SharedFiles.closeAll()` in `onDestroy`.
- Intercept the endpoint by installing a subclass of Capacitor's `BridgeWebViewClient` with `getBridge().setWebViewClient(...)` in `onCreate`. Its `shouldInterceptRequest` handles only paths starting with `/_uniview_shared/` on the bridge's own host, and delegates everything else to `super`. Responses are `WebResourceResponse` with `Cache-Control: no-store`.

### Page (packet 5b)

- New `src/shells/native-shared.ts`: `sharedSource(token, name, size, mime)` returning a `FileSource` whose `readRange(start, end, signal)` fetches the endpoint in at most 8 MiB requests and concatenates them; `readAll` reads `[0, size)`; `url()` uses `streamUrl` from `src/remote/stream.ts`; `release()` sends the close request once.
- `src/shells/index.ts`: install `window.__univiewOpenShared`, which turns each call into `sharedSource(...)` and hands it to `window.__univiewOpen([source])`; drain `window.__univiewPendingShared` like the existing pending queues. Failures while handing the file to the page surface through the existing `__univiewOpenError` channel with the file name; later read failures are shown by the file's viewer in its own tab, which already names the file (amended after Codex review, 2026-10-23).
- Unit tests `tests/unit/native-shared.test.ts` with a mocked `fetch`: request URLs and chunking for a 20 MiB range, end clamping at `size`, empty result for `start >= size`, error status becomes a thrown error, abort stops further requests, release sends close exactly once, and queued calls before install are delivered.

## Non-goals

No iOS changes; no change to the remote protocol; no new dependencies.

## Acceptance checks (the CTO runs them)

`npx tsc --noEmit`, `npm test`, `npm run build`, Android `testDebugUnitTest assembleDebug`, then on the Realme phone: open a large video and a PDF through VIEW and confirm via `adb shell du` on the app cache that nothing was copied, the video seeks, the PDF renders, and closing the tab releases the descriptor.

## Result (2026-10-23, Realme RMX, debug build)

- A 174 MB MP4 and a PDF opened through VIEW: the app cache did not grow (no copy), the video seeked to 3:20 and played from there, the PDF rendered, and closing the video tab closed its descriptor (checked in `/proc/<pid>/fd`).
- Found while testing: a cold-start VIEW opened the file twice (also on the old copy path, where the second read failed with "could not be read"). Capacitor's `BridgeActivity.load()` already passes the launch intent to `onNewIntent`, and `onCreate` handled it again. `handle` now ignores an Intent object it has already handled; opening the same file again on purpose still opens a second tab. The native fix is verified on the phone only (cold start: one tab, one token, one descriptor); `tests/e2e/native-open.web.spec.ts` covers the page side (a file queued before load or sent after load opens exactly one tab, and closing it sends one close).
