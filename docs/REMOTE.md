# Remote browsing: specification

A phone (or another computer) browses folders a paired computer chose to share, and opens files on demand without copying them. Large media streams in ranges. No account, no cloud, no relay: devices talk directly over the local network with end-to-end authenticated encryption.

## Roles

- **Host:** UniView desktop (Electron). Runs a small sharing service only while "Let my devices browse this computer" is on. Off by default.
- **Client:** any UniView with a ShellBridge transport: Android/iOS (Capacitor native HTTP), desktop (Electron main-process HTTP). The plain web build has no remote access (its CSP forbids it).

## Privacy and permissions

1. Nothing is shared until the host user adds a folder through a permission screen that states exactly what a paired device can do: see names and open files in that folder and below it, read only; it cannot write, delete, rename or upload.
2. A device can connect only after pairing (QR or code, one-time secret, 5-minute expiry) **and** the host user approving it in a native dialog. Trusted devices are listed and can be removed at any time; removal ends their sessions.
3. Everything after pairing is encrypted and authenticated end to end (AES-256-GCM with per-session keys from ephemeral ECDH). The service holds no plaintext secrets on disk except its own identity key, stored with the OS keychain (Electron `safeStorage`) where available.
4. The host keeps an access log (device, time, action, path) visible in the Sharing panel. Nothing leaves the local network.

## Cryptography (WebCrypto only, identical code on host and client: `shared/remote-protocol.mjs`)

- Curves and primitives: ECDH P-256, HKDF-SHA-256, HMAC-SHA-256, AES-256-GCM. Public keys are raw uncompressed points, base64url.
- Host identity: long-term ECDH key pair. Host ID = base64url(SHA-256(hostPub))[0..22].
- Client identity: long-term ECDH key pair per install; the private key is a non-extractable CryptoKey in IndexedDB. Device ID = base64url(SHA-256(clientPub))[0..22].

### Pairing offer

The host shows a QR code (and the same text as a copyable code):

```
uniview:pair?v=1&h=<ip>,<ip>&p=<port>&k=<hostPub>&s=<secret 32 bytes>&n=<host name>
```

The offer is valid for 5 minutes and 5 attempts, and is consumed by a successful pairing.

### `POST /v1/pair` (JSON)

Request `{v, devicePub, deviceName, nonce, mac}` with `mac = HMAC(secret, "uniview-pair-req" | hostPub | devicePub | nonce | deviceName)`. The host verifies the MAC (proof the client saw the QR), asks its user to approve, stores the device, and answers `{deviceId, hostName, mac}` with `mac = HMAC(secret, "uniview-pair-ok" | hostPub | devicePub | nonce | deviceId)`. The client checks it, which proves the server knows the secret and is bound to the `hostPub` from the QR.

### Static key

`Kst = HKDF(ECDH(own private, peer public), salt="uniview-v1-static", info=hostPub | devicePub, 32 bytes)`. Used only as an HMAC key for session setup.

### `POST /v1/session` (JSON)

Request `{v, deviceId, ePub, ts, nonce, mac}` with `mac = HMAC(Kst, "uniview-session" | deviceId | ePub | ts | nonce)`. The host rejects unknown devices, a timestamp more than 5 minutes off, or a reused nonce. It creates an ephemeral key, a 16-byte session ID, and answers `{sessionId, ePub, mac}` with `mac = HMAC(Kst, "uniview-session-ok" | sessionId | hostEPub | clientEPub)`. Only the real host can compute `Kst`, so this authenticates the host to the client.

Session keys: `HKDF(ECDH(ephemeral, ephemeral), salt=Kst, info="uniview-c2s"|sessionId)` and `…"uniview-s2c"|sessionId` (forward secrecy; separate keys per direction). Sessions last 12 hours and end when the device is removed or sharing stops.

### `POST /v1/rpc` (binary)

Request: `sessionId (16) | seq (u64 BE, 8) | AES-GCM(kC2S, iv = 0x00000001 | seq, aad = "uniview-rpc" | sessionId | seq, plaintext)`. The IV is unique per message by construction. The host keeps a 4096-entry sliding replay window, so parallel requests may arrive out of order but none can be replayed.

Response: `AES-GCM(kS2C, iv = 0x00000002 | seq, aad = "uniview-rpc-resp" | sessionId | seq, plaintext)`, where plaintext = `u32 jsonLength | json | payload bytes`.

Authentication failures return HTTP 401 with no detail. Application errors are returned inside the encrypted JSON as `{error}`.

### Operations

| op | args | result |
|---|---|---|
| `info` | | `{hostName, roots: [{id, name}]}` |
| `list` | `root, path` | `{entries: [{name, dir, size, mtime}]}`, folders first, hidden files skipped |
| `stat` | `root, path` | `{size, mtime}` |
| `read` | `root, path, start, end` | payload = bytes `[start, end)`, at most 4 MiB per call |
| `thumb` | `root, path, size ≤ 512` | payload = PNG from the OS thumbnailer, cached by path + mtime |

Paths are relative, `/`-separated, and resolved with `realpath` on every request; anything that resolves outside the shared folder (including through a symlink) is refused.

### Finding a computer whose address changed

When a paired host changes its local IP address (for example after a router reboot or DHCP lease renewal), existing connections may fail. If every known address fails with a connection error, the client scans the local /24 subnet for hosts answering `POST /v1/hello` with the expected public `hostId`.

Because `hostId` is public and grants no access, discovery alone does not establish trust. The client verifies the rediscovered address using the standard authenticated session handshake; only when cryptographic MAC verification succeeds does the client update the host's preferred address and notify listeners.

## Streaming

`RemoteFileSource` implements the normal `FileSource`, so every viewer works unchanged. Reads are split into 1 MiB-aligned chunks with an in-memory LRU cache (128 MiB) and up to 4 requests in flight.

Media (`url()`): a service worker answers `/__uniview_stream/<id>/<name>` range requests by asking the page for the decrypted bytes, so `<video>` and `<audio>` seek and play while downloading only what they need. Where service workers are unavailable (iOS WKWebView), the file is assembled in chunks into a Blob with progress shown.

## Limits and defaults

- Port 47823 (falls back to any free port); listens only while sharing is on.
- Request bodies ≤ 64 KiB; 30 session attempts per minute per address; pairing offers expire after 5 minutes or 5 failures.
- Read-only. No write operations exist in the protocol.

## Optional: Syncthing

If Syncthing is installed, the Sharing panel lists its folders (read from Syncthing's local `config.xml`, no network) so they can be shared with one click, after the same permission screen.
