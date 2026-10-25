<!--
  DRAFT FOR REVIEW. Not yet published.
  Before publishing: replace [CONTACT EMAIL] and [EFFECTIVE DATE], delete this comment and the
  "Verification notes (internal)" section, and host the result at a public https:// URL
  (Google Play requires a live, public privacy policy URL).
-->

# Verification notes (internal, remove before publishing)

Every statement in the policy below was checked against the code at branch `feat/v1-core`, commit `8c7e393` (2026-10-26). The checks were done by reading and searching the source. No packaged build was network-captured for this document.

## Claims I could not fully verify

1. **Android behaviour on a real device.** The no-network claim for the Android app rests on the code (`android/app/src/main/java/com/uniview/viewer/LanUrl.java` allows only private-network addresses and only the four `/v1/...` paths; the Capacitor HTTP plugin is switched off in `capacitor.config.json`; the web page's content security policy allows no remote hosts). `README.md` still says Android runtime behaviour is not verified on a device. An emulator or phone traffic capture has not been done. [VERIFY]
2. **Operating-system and framework behaviour.** The code contains no crash reporter, updater, analytics or telemetry (searched `src`, `electron`, `shared`, the Android Java sources and the Gradle files, case-insensitive). I did not inspect what the Chromium engine inside Electron, the Android WebView, Google Play, or Windows themselves record. The policy says so in plain words. [VERIFY]
3. **Windows uninstall.** `electron-builder.json` does not set `deleteAppDataOnUninstall`, so by electron-builder's documented default the uninstaller leaves `%APPDATA%\UniView` behind. I did not run an uninstall to confirm. The policy therefore tells people to delete that folder by hand. [VERIFY]
4. **Removing a recent file does not delete its preview image.** `forgetRecent` in `src/ui/recents.ts` removes the list entry only. `clearThumbs` in `src/remote/store.ts` exists but nothing calls it. The policy states this honestly. If you change the product later so the preview is deleted too, update the "How to delete your data" section. [VERIFY]
5. **Where the Windows data lives.** `%APPDATA%\UniView` is Electron's default for the product name "UniView" (documented in `electron/lib/mcp-runner.mjs`) and the folder exists on the build machine with the sub-folders named below. I did not inspect a fresh packaged install. [VERIFY]
6. **Policy URL.** No public URL exists yet. The effective date and contact address are placeholders. [VERIFY]
7. **Legal sufficiency.** This is a plain-language statement of what the software does. It was not reviewed by a lawyer and makes no claim about compliance with any specific law (GDPR, India DPDP Act, CCPA and so on). [VERIFY]

## How each main claim was checked

| Claim | Evidence |
|---|---|
| Windows app blocks every non-local request | `electron/main.mjs` `lockDown()`: `onBeforeRequest` cancels anything not matching `isAllowedUrl` (`uniview`, `uniview-file`, `blob`, `data`, `devtools`, `chrome-extension` schemes only, `electron/lib/core.mjs`). Also denies every permission request (camera, microphone, location, notifications). |
| Content security policy allows no remote host | `CSP` constant in `electron/main.mjs` and the matching `<meta>` tag in `index.html`: `default-src 'self'`, `connect-src 'self' blob: data: uniview-file:`, `object-src 'none'`, `form-action 'none'`. |
| Web build makes no outside requests | `tests/e2e/web.spec.ts` `beforeEach` throws on any request that is not `http://localhost:4173`, `blob:` or `data:`. It runs in CI (`web` and `mobile` projects). |
| Packaged app cannot reach the internet | `scripts/packaged-smoke.mjs` tries `fetch("https://example.com")` inside the packaged window and records `blocked`. |
| Only four `fetch(` calls exist in app code | `src/shells/electron.ts` and `src/shells/index.ts` and `src/shells/native-shared.ts`: all fetch the app's own `uniview-file://` URLs or the phone's own local file-sharing URL. None take a remote address. |
| No analytics, telemetry, updater, crash reporter, accounts | Case-insensitive search for `telemetry`, `analytics`, `gtag`, `sentry`, `crashReporter`, `autoUpdater`, `electron-updater`, `firebase`, `mixpanel`, `amplitude`, `posthog` across source, Android Java, Gradle files, `package.json`, `capacitor.config.json`, `electron-builder.json`: no hits. `google-services` is applied only if `android/app/google-services.json` exists; it does not. |
| Network only between your own paired devices | `electron/lib/remote-main.mjs` refuses any host that fails `isLanHost` ("Only devices on your local network can be contacted"); `electron/lib/share-host.mjs` refuses any peer that fails `isLanPeer` (`403 local network only`); Android `LanUrl.java` as above. Pairing and traffic are encrypted (ECDH P-256, HKDF-SHA-256, AES-256-GCM in `shared/remote-protocol.mjs`; protocol in `docs/REMOTE.md`). |
| Sharing is off by default and read-only | `docs/REMOTE.md` (Host section) and `share-host.mjs` (`enabled: !!saved.enabled`, no write operations). |
| Android permissions | `AndroidManifest.xml` declares only `INTERNET` and `CAMERA` (camera not required: `uses-feature ... required="false"`). `allowBackup="false"`. |
| Files are never uploaded | Nothing in the code sends file bytes to a remote server. Files go only to the viewer on the same device, or (when the person turns sharing on) to a paired device on the local network. |
| AI-assistant connector is local only | `electron/lib/bridge-server.mjs`: Windows named pipe or Unix socket (`net.createServer` on a pipe path, no TCP port); `electron/lib/mcp-server.mjs`: standard input and output only. `docs/AGENTS.md`: assistants cannot read file contents back or list folders through UniView. |

---

# UniView Privacy Policy

**Effective date:** [EFFECTIVE DATE]
**Contact:** [CONTACT EMAIL]

UniView is a file viewer for Windows and Android. This page explains, in plain words, what UniView does with your information. The short version: **UniView does not collect your information. It has no way to.**

## The short version

- No account, no sign-in, no sign-up.
- No analytics, no tracking, no advertising, no crash reporting to us.
- Your files are opened on your own device and are never uploaded anywhere.
- UniView makes no internet connections. The one kind of network traffic it can produce is between your own devices on your own local network, and only after you pair them (explained below).
- We do not receive any data about you or your files, so there is nothing for us to sell, share or leak.

## What UniView does on your device

**Opening files.** When you open a file, UniView reads it on your device and shows it to you. The file stays where it is. UniView does not edit, copy to a server, or send it anywhere.

**What UniView remembers on your device.** To make the app convenient it keeps a small amount of information locally:

- **Recent files:** the name, size, time opened and (on Windows) the location of files you opened lately, up to 50 entries.
- **Preview images:** small thumbnails of recent files, so the home screen can show them.
- **Settings:** for example light or dark theme and the name of your device.
- **Pairing information:** if you use the phone-to-computer feature, the identity key of your device and the list of computers (or devices) you paired with. Your device's private key is stored so that it cannot be exported.
- **On your computer, if you turn on sharing:** the folders you chose to share, the list of devices you approved, and the computer's own identity key (protected with Windows' secure storage where available). The short activity list shown in the Sharing panel is kept in memory only and disappears when the app closes.
- **If you use an AI assistant with UniView:** which assistants you allowed (and, for "Always allow", a key kept in the app's data folder), a short activity log (at most 500 entries and 30 days), and your review decisions (see below).

None of this leaves your device, except what is described under "Your own devices" below.

## Your own devices (local network only)

UniView can let your phone browse folders on your computer, without copying them first.

- This is **off by default**. Nothing is shared until you turn it on and choose a folder.
- Pairing needs both a one-time code (shown as a QR code) and your approval on the computer. You can remove any device at any time.
- The connection is direct, between your devices, on your own Wi-Fi or wired network. It is **read only**: the phone can see names and open files in the folders you chose, and cannot change, delete or upload anything.
- Everything after pairing is encrypted from end to end. There is no UniView server, relay or cloud in the middle.
- During pairing, your phone sends the computer its device name and a public key so the computer can recognise it. These go only to the computer you pair with.
- UniView refuses to contact or accept connections from anything that is not on a private local network address.
- While sharing is on, the computer listens on a network port so your phone can connect. It answers only devices on the local network.

On Android, the INTERNET permission exists only for this local-network feature. The camera permission is used only to scan the pairing QR code; images from the camera are read by the app on the spot, are not saved, and are not sent anywhere.

## AI assistants (optional)

UniView can work with AI coding assistants on your own computer, for example to show you a file or ask you to approve their work.

- The connection is local to your computer. It uses a private channel that only programs running under your Windows user account can reach, not the network.
- The first time an assistant asks, UniView shows you a prompt. You decide whether to allow it.
- Assistants cannot read the contents of your files or list your folders through UniView. They can ask UniView to display a file you could already open, and send text for you to review.
- When you approve or reject an assistant's review, UniView saves a small decision file next to the review file on your computer. It contains your decision, your optional comment and file checksums.
- UniView does not send anything to any assistant company. Each assistant program has its own privacy terms, which are separate from this policy.

## What UniView does not do

- It does not create accounts or ask for your name, email, phone number or location.
- It does not use advertising or analytics services.
- It does not contain a crash reporter or automatic updater that contacts anyone.
- It does not read your contacts, photos, microphone or location. (On Windows the app refuses all such permission requests.)
- It does not upload your files, filenames, previews or settings.

## Things outside UniView's control

UniView runs on top of Windows or Android, uses the web engine built into those systems or shipped with the app, and on Android is delivered through Google Play. Those systems may keep their own records (for example Google Play's install statistics, or the operating system's recent-documents list). Their practices are covered by their own policies, not this one. The UniView code itself sends nothing to them.

## How to delete your data

UniView stores nothing on any server, so there is nothing for us to delete. To remove what is on your device:

- **A single recent file:** on the home screen click **Remove** next to it. This removes it from the list. The small preview image may stay stored until you clear all app data (below).
- **A paired computer or device:** on the phone choose **Forget** next to the computer. On the computer open the Sharing panel and remove the device. Removing a device ends its access immediately.
- **An AI assistant:** open the **Agents** panel and click **Revoke**. This deletes its stored key and ends its sessions. You can also delete the `agents` folder shown below.
- **Everything, on Android:** Settings, Apps, UniView, Storage, **Clear storage** (or uninstall the app). Uninstalling removes the app's data. UniView turns Android's cloud backup off for its data.
- **Everything, on Windows:** uninstall UniView, then delete the folder `%APPDATA%\UniView` (paste that into the File Explorer address bar). It holds recent files, previews, settings, pairing keys, the `agents` folder, the `remote` folder and the `reviews` folder. The uninstaller does not necessarily delete this folder for you.
- **Review decision files:** delete the files named `*.decision.json` that sit next to your review files.

## Children

UniView collects no personal information from anyone, including children.

## Changes to this policy

If UniView ever changes in a way that affects this policy, we will update this page and its effective date before the change ships. Because UniView has no accounts, we cannot email you, so please check this page and the app's release notes.

## Contact

Questions about this policy: [CONTACT EMAIL]
