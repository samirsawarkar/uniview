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
