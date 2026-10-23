# Streaming shared files on Android and iOS

Research by hermes (AES run `aes-d2c66cb038da`, 2026-10-23).

# Zero-Copy On-Demand Document Streaming for UniView (Capacitor 8)

## Executive Summary

UniView currently buffers shared documents up to 2 GB into private temporary directories (`getCacheDir()/shared` on Android and `FileManager.default.temporaryDirectory/shared` on iOS) and serves them via same-origin `/_capacitor_file_/` URLs. This approach introduces high initial latency (I/O copy of gigabyte files), doubles device flash storage consumption, and causes memory/disk pressure during large video playback.

Both Android and iOS provide native primitives to stream file byte ranges on demand directly from the original source without copying:
- **Android:** Transient `FLAG_GRANT_READ_URI_PERMISSION` grants can be converted into open `ParcelFileDescriptor` handles for random-access seek reads (`pread` / `FileChannel`). Media requests from `<video>` reach `WebViewClient.shouldInterceptRequest` with `Range` headers in Android WebView 100+, but require handling a known Chromium range re-application quirk (Chromium Issue 40739128) and the 32-bit `InputStream.available()` 2 GB limit.
- **iOS:** Setting `LSSupportsOpeningDocumentsInPlace=YES` prevents iOS from copying files to `Documents/Inbox`. Security-scoped URLs accessed via `startAccessingSecurityScopedResource()` can be streamed directly via `WKURLSchemeHandler` with HTTP 206 Partial Content, backed by persistent security-scoped bookmarks for reopening.

Below is the complete architectural analysis, platform options breakdown, recommended designs, and implementation sketches.

---

## 1. Android Deep-Dive & Options Analysis

### 1.1 URI Permission Lifecycle: VIEW vs. SEND & Persistable Permissions
When another application sends a document via `ACTION_VIEW` ("Open with") or `ACTION_SEND` (Share sheet), it delivers a `content://` URI accompanied by the intent flag `Intent.FLAG_GRANT_READ_URI_PERMISSION`.

* **Lifecycle of Transient VIEW / SEND Grants:**
  Transient URI grants are managed by Android's `UriGrantsManagerService`. The grant is tied directly to the receiving `Activity` record and task stack. The permission remains valid **only** as long as the Activity is alive in the foreground or retained in recent tasks. As soon as the Activity finishes (`onDestroy()`) or the user clears the app task from the Recents screen, the system automatically revokes the URI grant.
* **Limits of `takePersistableUriPermission`:**
  Calling `contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)` requires that the caller explicitly included `Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION`. 
  - Standard file managers, messaging apps (WhatsApp, Telegram, Slack), and email clients (Gmail) dispatch `ACTION_VIEW` and `ACTION_SEND` with `FLAG_GRANT_READ_URI_PERMISSION` **only**; they do not set `FLAG_GRANT_PERSISTABLE_URI_PERMISSION`.
  - If UniView calls `takePersistableUriPermission` on a URI without this sender flag, the Android framework throws a fatal:
    ```
    java.lang.SecurityException: No persistable permission grants found for UID ... to URI ...
    ```
  - Persistable permissions are guaranteed exclusively for URIs picked through the Storage Access Framework (`ACTION_OPEN_DOCUMENT`, `ACTION_OPEN_DOCUMENT_TREE`, `ACTION_CREATE_DOCUMENT`).
  - **Conclusion:** UniView cannot persist VIEW or SEND grants across app restarts. Document reading must occur while the Activity session is active, or the file descriptor must be held open.

### 1.2 `ParcelFileDescriptor` & `AssetFileDescriptor` for Random-Access Reads
While the transient permission is active during `onCreate()` / `onNewIntent()`, the app can open the URI directly via `ContentResolver`:
```java
ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(uri, "r");
```
* **Capabilities:**
  - `pfd.getStatSize()`: Obtains the exact 64-bit file size without scanning or copying.
  - `pfd.getFileDescriptor()`: Yields the native Linux file descriptor (`int fd`).
  - **Zero-Copy Random Access:** `FileChannel` (`new FileInputStream(pfd.getFileDescriptor()).getChannel()`) allows seeking to arbitrary 64-bit offsets (`channel.position(offset)`) and reading specific chunk sizes directly into memory buffers via `channel.read(byteBuffer)` or `android.system.Os.pread(...)`.
  - Holding an open `ParcelFileDescriptor` allows continued reads even if background state changes, until UniView explicitly calls `pfd.close()`.

### 1.3 Android WebView 100+: `<video>` Range Requests & `shouldInterceptRequest`
* **Do Range Requests Reach `shouldInterceptRequest`?**
  **Yes.** In modern Android WebView (starting from Chromium-based WebView 33+ through WebView 100+ and current versions), all HTML5 media requests (`<video>` and `<audio>`) are routed through Chromium's network service and invoke `WebViewClient.shouldInterceptRequest(WebView view, WebResourceRequest request)` on a background binder thread.
* **Request Headers:**
  `request.getRequestHeaders()` contains the HTTP `Range` header (e.g. `Range: bytes=0-` for initial codec/metadata probing, or `Range: bytes=1048576-` when seeking).

### 1.4 The Chromium Range Re-application Bug (Issue 40739128) & 2 GB Bounds
When responding to a `Range` request in `shouldInterceptRequest`, Chromium's native URL loader (`android_stream_reader_url_loader.cc`) exhibits a known design flaw:
1. **The Double-Skip Bug:** When a request has a `Range: bytes=X-` header, Chromium's native `InputStreamReader::Seek` calls `InputStream.skip(X)` on the returned `InputStream`, **regardless of whether the HTTP response status is 200 or 206**.
   - If the application returns a standard HTTP 206 response where the `InputStream` is already sought or sliced to byte `X`, Chromium skips `X` bytes into the slice.
   - For a seek request, skipping `X` into a sliced stream jumps past EOF, resulting in `net::ERR_FAILED` or distorted media.
2. **The 32-bit `available()` Overflow (> 2 GB):**
   Chromium's `InputStreamReader::VerifyRequestedRange` invokes `InputStream.available()`. In Java, `available()` returns a 32-bit signed `int` (maximum `2,147,483,647` bytes / 2 GB). For files > 2 GB, `available()` overflows or returns negative values, causing Chromium to reject the range with `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`.
3. **The Solution:**
   - To serve HTTP 206 safely to Chromium's `<video>`, the returned `InputStream` must wrap the file channel and absorb Chromium's initial `skip(X)` without skipping real body bytes, and clamp `available()` to `Int.MAX_VALUE` or return 0 (which bypasses Chromium's length assertion).
   - Alternatively, for non-media random reads (`readRange(start, end)` in JS), passing start and end as query parameters (`?start=X&end=Y`) and returning HTTP 200 avoids the `Range` header entirely, bypassing Chromium's `Seek` logic.

### 1.5 Evaluation of Android Options
1. **`WebViewAssetLoader.PathHandler`:**
   `PathHandler` only exposes `handle(String path)`. It does not receive `WebResourceRequest` or HTTP headers. It cannot read the `Range` header and cannot serve HTTP 206 for `<video>`.
2. **Capacitor's Built-in `WebViewLocalServer` (`/_capacitor_content_/`):**
   Capacitor has an unadvertised `/_capacitor_content_/` route in `WebViewLocalServer.java`, but its range handler uses `responseStream.available()` as the total file size (failing on streams and files > 2 GB), does not perform seek offsets, does not validate access tokens (unscoped access to any content URI), and `WebViewLocalServer.register()` is package-private.
3. **Custom Bridge Interceptor / Plugin:**
   Subclassing `BridgeWebViewClient` in `MainActivity` or hooking into Capacitor allows registering a dedicated virtual route (e.g. `https://localhost/_uniview_stream_/<token>`) backed by a token-mapped `ParcelFileDescriptor`.

---

## 2. iOS Deep-Dive & Options Analysis

### 2.1 `LSSupportsOpeningDocumentsInPlace=YES` Implications
UniView's current `ios/App/App/Info.plist` configures:
```xml
<key>LSSupportsOpeningDocumentsInPlace</key>
<false/>
```
* **When `false`:** Whenever the user opens a file from the Files app, iCloud Drive, AirDrop, or another app via "Open in UniView", the iOS system automatically creates a duplicate of the file inside the app's `Documents/Inbox/` directory before `SceneDelegate` receives the URL. For a 2 GB video, 2 GB is duplicated on the device before any Swift code executes.
* **When `true`:** iOS passes a security-scoped URL directly pointing to the file in its original location (external app container, iCloud container, or file provider). No file copy is created. Access is instant and takes 0 bytes of additional disk space.
* **Requirements:** The app must support security-scoped resource access and file coordination.

### 2.2 Security-Scoped URLs & Resource Access Management
When `LSSupportsOpeningDocumentsInPlace` is `YES`, the file URL delivered to `scene(_:openURLContexts:)` is security-scoped.
* **Access Rules:**
  - The app must call `url.startAccessingSecurityScopedResource()` before accessing file metadata or reading bytes.
  - If `startAccessingSecurityScopedResource()` returns `true`, every successful call must be balanced by exactly one `url.stopAccessingSecurityScopedResource()`.
  - Access is granted at the process level: while active, any thread, `FileHandle`, or `WKURLSchemeHandler` running within the app process can access the file.
  - If `stopAccessingSecurityScopedResource()` is called while the WebView is still reading chunks, subsequent reads will fail immediately with POSIX permission error 1 (`EPERM: Operation not permitted`).

### 2.3 Security-Scoped Bookmark Data for Re-opening
If the user wants UniView to reopen recently viewed files from the Home page across app restarts:
* Standard file paths will fail to open on subsequent launches because the transient sandbox extension expires when the app terminates.
* UniView must generate a security-scoped bookmark:
  ```swift
  let bookmarkData = try url.bookmarkData(
      options: .minimalBookmark,
      includingResourceValuesForKeys: nil,
      relativeTo: nil
  )
  ```
* On subsequent app launches, resolve the bookmark:
  ```swift
  var isStale = false
  let resolvedURL = try URL(
      resolvingBookmarkData: bookmarkData,
      options: [],
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
  )
  if resolvedURL.startAccessingSecurityScopedResource() {
      // Stream file...
  }
  ```

### 2.4 `WKURLSchemeHandler` & Media Range Support
In WKWebView, `http` and `https` schemes cannot be handled by custom scheme handlers. However, Capacitor runs the app on a custom scheme (e.g. `capacitor://localhost` or custom `uniview-file://`).
* **Built-in Capacitor Range Support:**
  Capacitor iOS's `WebViewAssetHandler.swift` already implements HTTP 206 Partial Content handling for URLs matching `/_capacitor_file_/` using `FileHandle.seek(toOffset:)`. However, it does not manage security-scoped URLs and exposes arbitrary file paths.
* **Dedicated Scheme Handler (`uniview-file://`):**
  Registering a dedicated `WKURLSchemeHandler` allows serving file slices on demand using tokenized handles.
* **Critical Threading & Crash Constraints:**
  - `webView(_:start:)` and `webView(_:stop:)` execute on the main thread.
  - Slicing and reading from disk should occur on a background queue (`DispatchQueue.global(qos: .userInitiated)`).
  - **Fatal Pitfall:** If `webView(_:stop:)` is triggered by WebKit (e.g. when `<video>` aborts a request) and the background task subsequently calls `urlSchemeTask.didReceive()` or `urlSchemeTask.didFinish()`, WebKit throws an uncaught Objective-C exception:
    ```
    NSInternalInconsistencyException: This task has already been stopped
    ```
    This immediately crashes the app.
  - **Remedy:** All active `WKURLSchemeTask` instances must be tracked in a thread-safe registry protected by `os_unfair_lock` or a synchronized dispatch queue, and flagged as stopped before any callbacks are made.

---

## 3. Recommendations & Implementation Sketches

### Unified Architectural Pattern: Tokenized On-Demand FileSource
Mirroring UniView's existing Electron architecture (`src/shells/electron.ts`), both Android and iOS should use a **tokenized handle model**:
1. When an external intent/URL arrives, native code registers the file in an in-memory session map: `tokens.set(token, fileHandle)`.
2. Native code sends the UI `{ token, name, size, mimeHint }`.
3. The UI creates a `FileSource`:
   - `readRange(start, end)`: calls `fetch("https://localhost/_uniview_stream_/" + token + "?start=" + start + "&end=" + end)` which streams exact bytes with status 200 (no `Range` header, avoiding browser range quirks).
   - `url()`: returns `https://localhost/_uniview_stream_/" + token + "/" + encodeURIComponent(name)`. When `<video>` requests this URL, it sends `Range: bytes=X-`, and native responds with HTTP 206 Partial Content.
   - `release()`: sends a message to native to close the file descriptor / stop accessing security-scoped resource.

---

### 3.1 Android Recommended Approach: Token-Mapped Interceptor & `ParcelFileDescriptor`

#### Architecture
- **Intent Reception:** `MainActivity` intercepts `ACTION_VIEW` and `ACTION_SEND`, queries display name and size from `ContentResolver`, opens a `ParcelFileDescriptor`, and stores it in `SharedFileManager`.
- **Interception:** Subclass `BridgeWebViewClient` to intercept `https://localhost/_uniview_stream_/<token>`.
- **Range Handling:**
  - If `request.getUrl().getQueryParameter("start") != null`: read the specific byte slice and return HTTP 200 with `Content-Length`.
  - If request has `Range` header: compute bounds, return HTTP 206 with `Content-Range`, and wrap stream to absorb Chromium's automatic `skip`.

#### Implementation Sketch

```java
// SharedFileManager.java
package com.uniview.viewer;

import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class SharedFileManager {
    public static class Entry {
        public final String token = UUID.randomUUID().toString();
        public final Uri uri;
        public final String name;
        public final long size;
        public final String mime;
        public final ParcelFileDescriptor pfd;

        public Entry(Uri uri, String name, long size, String mime, ParcelFileDescriptor pfd) {
            this.uri = uri;
            this.name = name;
            this.size = size;
            this.mime = mime;
            this.pfd = pfd;
        }

        public void close() {
            try { pfd.close(); } catch (IOException ignored) {}
        }
    }

    private static final Map<String, Entry> active = new ConcurrentHashMap<>();

    public static Entry register(Uri uri, String name, long size, String mime, ParcelFileDescriptor pfd) {
        Entry e = new Entry(uri, name, size, mime, pfd);
        active.put(e.token, e);
        return e;
    }

    public static Entry get(String token) { return active.get(token); }
    public static void release(String token) {
        Entry e = active.remove(token);
        if (e != null) e.close();
    }
}
```

```java
// StreamInterceptor.java
package com.uniview.viewer;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.util.HashMap;
import java.util.Map;

public final class StreamInterceptor {
    public static WebResourceResponse intercept(WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path == null || !path.startsWith("/_uniview_stream_/")) return null;

        String[] parts = path.substring("/_uniview_stream_/".length()).split("/");
        String token = parts[0];
        SharedFileManager.Entry entry = SharedFileManager.get(token);
        if (entry == null) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
        }

        try {
            FileChannel channel = new FileInputStream(entry.pfd.getFileDescriptor()).getChannel();
            String startParam = request.getUrl().getQueryParameter("start");
            String endParam = request.getUrl().getQueryParameter("end");

            // Path A: Explicit byte range via query parameters (for JS readRange)
            if (startParam != null && endParam != null) {
                long start = Long.parseLong(startParam);
                long end = Long.parseLong(endParam);
                long length = end - start;
                InputStream stream = new BoundedFileInputStream(channel, start, length);
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", entry.mime != null ? entry.mime : "application/octet-stream");
                headers.put("Content-Length", String.valueOf(length));
                headers.put("Access-Control-Allow-Origin", "*");
                return new WebResourceResponse(entry.mime, "binary", 200, "OK", headers, stream);
            }

            // Path B: Standard HTTP Range header (for <video> / <audio>)
            Map<String, String> reqHeaders = request.getRequestHeaders();
            String rangeHeader = reqHeaders.get("Range");
            if (rangeHeader == null) rangeHeader = reqHeaders.get("range");

            if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                String[] rangeParts = rangeHeader.substring(6).split("-");
                long start = Long.parseLong(rangeParts[0]);
                long end = rangeParts.length > 1 && !rangeParts[1].isEmpty() 
                           ? Long.parseLong(rangeParts[1]) 
                           : entry.size - 1;
                long contentLength = end - start + 1;

                // Wrap stream with SkippedPrefixInputStream to absorb Chromium's double-skip
                InputStream stream = new SkippedPrefixInputStream(start, channel, start, contentLength);
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Type", entry.mime != null ? entry.mime : "application/octet-stream");
                headers.put("Content-Range", "bytes " + start + "-" + end + "/" + entry.size);
                headers.put("Content-Length", String.valueOf(contentLength));
                headers.put("Accept-Ranges", "bytes");
                headers.put("Access-Control-Allow-Origin", "*");
                return new WebResourceResponse(entry.mime, "binary", 206, "Partial Content", headers, stream);
            }

            // Path C: Full stream (status 200)
            InputStream stream = new BoundedFileInputStream(channel, 0, entry.size);
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Length", String.valueOf(entry.size));
            headers.put("Accept-Ranges", "bytes");
            return new WebResourceResponse(entry.mime, "binary", 200, "OK", headers, stream);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "UTF-8", 500, "Internal Error", null, null);
        }
    }
}
```

```java
// MainActivity.java hook
@Override
public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView webView = getBridge().getWebView();
    webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            WebResourceResponse res = StreamInterceptor.intercept(request);
            if (res != null) return res;
            return super.shouldInterceptRequest(view, request);
        }
    });
}
```

---

### 3.2 iOS Recommended Approach: In-Place Security Scope & `WKURLSchemeHandler`

#### Architecture
1. **`Info.plist`:** Set `<key>LSSupportsOpeningDocumentsInPlace</key><true/>`.
2. **`SceneDelegate`:** On document open, call `url.startAccessingSecurityScopedResource()`, generate a token, store the URL and active scope in `DocumentScopeManager`, and hand `{ token, name, size, mime }` to the page.
3. **`StreamSchemeHandler`:** A custom `WKURLSchemeHandler` for `uniview-file` (or intercepting Capacitor's scheme):
   - Opens `FileHandle` directly on the security-scoped URL.
   - Responds to `Range` headers with HTTP 206 and `Content-Range`.
   - Protects against the task cancellation crash using an `os_unfair_lock`.

#### Implementation Sketch

```swift
// DocumentScopeManager.swift
import Foundation

final class DocumentScopeManager {
    static let shared = DocumentScopeManager()
    struct Record {
        let url: URL
        let isScoped: Bool
        let size: Int64
        let name: String
    }
    private var records: [String: Record] = [:]
    private let lock = NSLock()

    func register(url: URL) -> (token: String, size: Int64, name: String)? {
        let isScoped = url.startAccessingSecurityScopedResource()
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        let name = url.lastPathComponent
        let token = UUID().uuidString

        lock.lock()
        records[token] = Record(url: url, isScoped: isScoped, size: size, name: name)
        lock.unlock()

        return (token, size, name)
    }

    func get(token: String) -> Record? {
        lock.lock()
        defer { lock.unlock() }
        return records[token]
    }

    func release(token: String) {
        lock.lock()
        guard let record = records.removeValue(forKey: token) else {
            lock.unlock()
            return
        }
        lock.unlock()
        if record.isScoped {
            record.url.stopAccessingSecurityScopedResource()
        }
    }
}
```

```swift
// StreamSchemeHandler.swift
import Foundation
import WebKit
import UniformTypeIdentifiers

final class StreamSchemeHandler: NSObject, WKURLSchemeHandler {
    private var activeTasks: [ObjectIdentifier: Bool] = [:]
    private var lock = os_unfair_lock_s()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskId = ObjectIdentifier(urlSchemeTask)
        os_unfair_lock_lock(&lock)
        activeTasks[taskId] = true
        os_unfair_lock_unlock(&lock)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.handleRequest(urlSchemeTask, taskId: taskId)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskId = ObjectIdentifier(urlSchemeTask)
        os_unfair_lock_lock(&lock)
        activeTasks.removeValue(forKey: taskId)
        os_unfair_lock_unlock(&lock)
    }

    private func isTaskActive(_ taskId: ObjectIdentifier) -> Bool {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return activeTasks[taskId] == true
    }

    private func handleRequest(_ task: WKURLSchemeTask, taskId: ObjectIdentifier) {
        guard let url = task.request.url,
              let host = url.host,
              let record = DocumentScopeManager.shared.get(token: host) else {
            if isTaskActive(taskId) { task.didFailWithError(URLError(.fileDoesNotExist)) }
            return
        }

        do {
            let handle = try FileHandle(forReadingFrom: record.url)
            defer { try? handle.close() }

            let totalSize = record.size
            let mimeType = UTType(filenameExtension: record.url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            var headers: [String: String] = [
                "Content-Type": mimeType,
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*"
            ]

            let rangeHeader = task.request.value(forHTTPHeaderField: "Range")
            if let rangeHeader = rangeHeader, rangeHeader.hasPrefix("bytes=") {
                let parts = rangeHeader.replacingOccurrences(of: "bytes=", with: "").components(separatedBy: "-")
                let start = Int64(parts[0]) ?? 0
                let end = parts.count > 1 && !parts[1].isEmpty ? (Int64(parts[1]) ?? (totalSize - 1)) : (totalSize - 1)
                let length = end - start + 1

                try handle.seek(toOffset: UInt64(start))
                let data = handle.readData(ofLength: Int(length))

                headers["Content-Range"] = "bytes \(start)-\(end)/\(totalSize)"
                headers["Content-Length"] = String(data.count)

                guard let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
                guard isTaskActive(taskId) else { return }
                task.didReceive(response)
                guard isTaskActive(taskId) else { return }
                task.didReceive(data)
                guard isTaskActive(taskId) else { return }
                task.didFinish()
            } else {
                headers["Content-Length"] = String(totalSize)
                guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
                guard isTaskActive(taskId) else { return }
                task.didReceive(response)
                let data = handle.readData(ofLength: min(Int(totalSize), 4 * 1024 * 1024))
                guard isTaskActive(taskId) else { return }
                task.didReceive(data)
                guard isTaskActive(taskId) else { return }
                task.didFinish()
            }
        } catch {
            guard isTaskActive(taskId) else { return }
            task.didFailWithError(error)
        }
    }
}
```

---

### 3.3 JS FileSource Contract Integration
The JavaScript bridge in `src/shells/` seamlessly maps the tokenized native handle to the existing `FileSource` interface:

```ts
// src/shells/native-source.ts
import type { FileSource } from "../core/types";
import { nextId } from "./sources";

export interface NativeGrantedFile {
  token: string;
  name: string;
  size: number;
  mime?: string;
  streamUrl: string; // e.g. "https://localhost/_uniview_stream_/<token>"
}

export function createNativeSource(granted: NativeGrantedFile): FileSource {
  return {
    id: nextId(),
    name: granted.name,
    size: granted.size,
    mimeHint: granted.mime,
    readAll: async (signal) => {
      const res = await fetch(`${granted.streamUrl}?start=0&end=${granted.size}`, { signal });
      return res.arrayBuffer();
    },
    readRange: async (start, end, signal) => {
      const res = await fetch(`${granted.streamUrl}?start=${start}&end=${end}`, { signal });
      return res.arrayBuffer();
    },
    url: async () => `${granted.streamUrl}/${encodeURIComponent(granted.name)}`,
    release: () => {
      // Notify native to close ParcelFileDescriptor / stopAccessingSecurityScopedResource
      if ((window as any).Capacitor?.isNativePlatform?.()) {
        (window as any).Capacitor.Plugins.UniViewNativeFiles?.release({ token: granted.token });
      }
    },
  };
}
```

---

### 3.4 Memory and Security Considerations
1. **Restricting Scope to Explicitly Granted Files:**
   - Raw filesystem paths (`/_capacitor_file_/var/mobile/...` or `/storage/emulated/0/...`) must **never** be accepted directly from web requests.
   - Only UUID tokens stored in the native `ConcurrentHashMap` / `NSLock`-protected dictionary during an explicit `ACTION_VIEW`, `ACTION_SEND`, or system document picker event are servable. Unknown tokens immediately return HTTP 404/403.
2. **Preventing File Descriptor and Sandbox Leaks:**
   - The native registry releases handles when the tab closes via `source.release()`.
   - On Android, `MainActivity.onDestroy()` closes all open `ParcelFileDescriptor` instances.
   - On iOS, `SceneDelegate` closes all active security scopes upon session destruction.
3. **Memory Safety with Multi-Gigabyte Files:**
   - Bytes are streamed directly from kernel file descriptors into network buffers or slices. At no point is the entire file read into the JVM or WebKit heap, eliminating Out-Of-Memory (OOM) crashes on 2 GB+ files.

---

### 3.5 Testing Strategy
1. **Unit Testing (JUnit / XCTest):**
   - **Android:** Test `StreamInterceptor` using mock `WebResourceRequest` inputs. Verify that requests with `?start=0&end=1024` return status 200 with `Content-Length: 1024`, and requests with `Range: bytes=100-200` return status 206 with `Content-Range: bytes 100-200/<size>`.
   - **iOS:** Test `StreamSchemeHandler` with mock `WKURLSchemeTask` objects. Verify that task stopping before response does not cause `didFailWithError` or `didReceive` invocation.
2. **Integration & Large File Verification:**
   - Create a sparse/test MP4 file exceeding 2.5 GB using `scripts/make-fixtures.mjs`.
   - Open the file via `adb shell am start -a android.intent.action.VIEW -d <content_uri> -t video/mp4` on Android Emulator (API 34, WebView 120+).
   - Verify:
     1. Cold open takes < 300 ms (no 2 GB copy delay).
     2. Flash cache remains 0 bytes.
     3. Seeking to the final 10 seconds of the 2.5 GB video plays without `net::ERR_FAILED` or `MEDIA_ERR_SRC_NOT_SUPPORTED`.
   - On iOS Simulator / Device:
     1. Open file from Files app.
     2. Verify no file is written to `Documents/Inbox/`.
     3. Verify seeking in `<video>` loads chunks smoothly via `WKURLSchemeHandler`.

---

## 4. Authoritative Documentation Citations

### Android Documentation
* **`ContentResolver.takePersistableUriPermission` & `SecurityException`:**
  https://developer.android.com/reference/android/content/ContentResolver#takePersistableUriPermission(android.net.Uri,%20int)
* **Intent URI Permission Flags (`FLAG_GRANT_READ_URI_PERMISSION`, `FLAG_GRANT_PERSISTABLE_URI_PERMISSION`):**
  https://developer.android.com/reference/android/content/Intent#FLAG_GRANT_READ_URI_PERMISSION  
  https://developer.android.com/reference/android/content/Intent#FLAG_GRANT_PERSISTABLE_URI_PERMISSION
* **`ParcelFileDescriptor` & Seekable File Channels:**
  https://developer.android.com/reference/android/os/ParcelFileDescriptor
* **`WebViewClient.shouldInterceptRequest` & `WebResourceRequest`:**
  https://developer.android.com/reference/android/webkit/WebViewClient#shouldInterceptRequest(android.webkit.WebView,%20android.webkit.WebResourceRequest)
* **`WebViewAssetLoader` & PathHandler Specifications:**
  https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader  
  https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader.PathHandler
* **Chromium Native URL Loader Range Skip Quirk (Issue 40739128 / Issue 571186732):**
  https://issues.chromium.org/issues/40739128

### Apple Documentation
* **`LSSupportsOpeningDocumentsInPlace` Information Property List Key:**
  https://developer.apple.com/documentation/bundleresources/information_property_list/lssupportsopeningdocumentsinplace
* **Security-Scoped URL Access (`startAccessingSecurityScopedResource`, `stopAccessingSecurityScopedResource`):**
  https://developer.apple.com/documentation/foundation/nsurl/1417051-startaccessingsecurityscopedresource  
  https://developer.apple.com/documentation/foundation/nsurl/1413736-stopaccessingsecurityscopedresource
* **Security-Scoped Bookmarks (`bookmarkData`, `init(resolvingBookmarkData:)`):**
  https://developer.apple.com/documentation/foundation/nsurl/1417795-bookmarkdata  
  https://developer.apple.com/documentation/foundation/nsurl/1412479-init
* **`WKURLSchemeHandler` & `WKURLSchemeTask` Lifecycle:**
  https://developer.apple.com/documentation/webkit/wkurlschemehandler  
  https://developer.apple.com/documentation/webkit/wkurlschemetask

### Capacitor Documentation
* **Capacitor Custom Native Android Plugins & Bridges:**
  https://capacitorjs.com/docs/plugins/android
* **Capacitor Custom Native iOS Plugins & Schemes:**
  https://capacitorjs.com/docs/plugins/ios
