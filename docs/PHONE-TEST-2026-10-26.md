# Real-phone pairing test, 26 October 2026

**Phone:** Realme RMX2002 (Android), UniView debug APK built from `73ed049`, same Wi-Fi as the PC (192.168.1.x).
**PC:** the unpackaged app (`npx electron .`) with a fresh profile, sharing `I:\AES\Data\uniview-lan-test\share` (a Docs folder and Media with a 174 MB video).
**Scripts:** `demo/phone-test-host.mjs` (PC side), `demo/phone-test-revoke.mjs` (revoke step). Screenshots: `demo/phone-test-results/`.

## Results

| Step | Result |
|---|---|
| Install on the phone | OK |
| Phone reaches the PC over Wi-Fi and pairs with the pairing code (pasted, the QR camera was not used) | OK; the PC recorded the device, the phone showed the PC |
| Browse shared folders from the phone (Docs, Media) | OK |
| Open the 174 MB video | The tab showed "Opening…" at 1.3 s and a ready player (4:00 long, thumbnail in the listing) by 2.9 s after the tap |
| Seek far ahead (to 3:00 of 4:00) | New frame shown within 1.6 s of the tap |
| Revoke the phone on the PC | Done in 0.5 s on the PC |
| Phone after revoke | "Saurabh no longer trusts this device. Pair again." |

Timings come from timestamped adb screenshots (each screenshot adds about 0.5 s), so they are upper bounds, not exact.

## Findings
1. The default device name on this phone is "RMX2002 Build/RP1A.200720.011" (the " Build/…" suffix we thought was fixed is still there for this model).
2. The camera preview in the pairing dialog was a black box; QR scanning was not verified on the phone (the pasted code worked). Needs a check of the camera permission prompt and the scanner on this phone.
3. Phone Wi-Fi was off at the start of the test; it was switched on for the test and left on.
4. The pairing approval on the PC happened without my script clicking it; the PC owner approved the native prompt (or it auto-approved). Not independently confirmed.

## Follow-up: findings 1 and 2 re-tested on the same phone (RMX2002)

**Finding 1 (device name).** The WebView user agent is `... Android 11; RMX2002 Build/RP1A.200720.011; wv ...`. The earlier fix already stripped ` Build/...` from the default, but the name had been saved to localStorage by an older build, and the saved value was returned unchanged. Now: one shared cleaner (`shared/device-name.mjs`) drops ` Build/...`, `wv` and trailing dotted version numbers and puts a brand in front of well-known model codes (`RMX...` becomes `realme RMX...`, `SM-...` becomes `Samsung SM-...`, `CPH...` becomes `OPPO CPH...`). A saved name that still contains `Build/` is cleaned and re-saved once; names a person typed are left alone. The computer's device list applies the same cleanup for display only. Verified on the phone: after installing over the old build the dialog shows `realme RMX2002`.

**Finding 2 (camera).** `android.permission.CAMERA` is declared in the manifest and was already granted (`dumpsys package`: `CAMERA: granted=true`), so no prompt appears; Capacitor's WebChromeClient grants `getUserMedia`. Over the WebView DevTools socket: `getUserMedia({facingMode:"environment"})` resolves, the track is `live`, 480x640 at 30 fps, `<video>` `readyState` 4 and `currentTime` advancing, `BarcodeDetector` is available. The frames from the rear camera are all black (mean brightness 0) while the front camera gives a normal picture (mean about 178; a ceiling and fan were visible in the screenshot after tapping the new "Switch camera" button). The phone was lying face up, so the rear lens was against the table. The black box was therefore not a permission or code failure; the scanner had no way to tell the user. Changes: `autoPlay` on the video, `play()` rejection handled, a black-picture detector (mean brightness over about 2.5 s) that shows "The camera picture is black. Uncover the lens, or switch to the other camera." and a "Switch camera" button (rear/front). Decoding is covered by a unit test that renders a generated pairing QR to pixels and decodes it with jsQR (`tests/unit/qr-scan.test.ts`). Not verified: decoding a real QR through the live camera (nobody held the phone to a screen).
