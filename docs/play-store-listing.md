# UniView: Google Play listing and closed-testing plan

Everything below is ready to paste into Play Console. Facts come from this repository (package `com.uniview.viewer`, `versionCode 1`, `versionName 1.0`, `minSdk 26`, `targetSdk 36`, permissions `INTERNET` and `CAMERA`). Items marked **[VERIFY]** could not be confirmed from the repository and must be checked in Play Console or on a phone before submitting. Policy details about Play come from the Hermes brief (`docs/CEO-DECISIONS.md`, Decision 5) and were not re-checked against Google's live pages.

Placeholders to fill: `[CONTACT EMAIL]`, `[PRIVACY POLICY URL]` (host `docs/PRIVACY.md` publicly; Play requires a live URL), `[DEVELOPER NAME]`, `[WEBSITE]` (optional).

---

## 1. Main store listing (English, United States)

### App name (max 30 characters)

```
UniView: Offline File Viewer
```
(28 characters.)

### Short description (max 80 characters)

```
Open PDF, Word, Excel, PowerPoint, images and more. Offline. No account.
```
(72 characters.)

### Full description (max 4000 characters)

```
UniView opens your files. Nothing else.

One simple app for reading documents, spreadsheets, presentations, books, images, audio, video, code and archives. There is no account to create, no ads, no tracking and no cloud. Your files are opened on your phone and stay on your phone.

WHAT IT OPENS
- PDF documents: smooth scrolling, selectable text, search and zoom
- Word documents (docx)
- Spreadsheets: xlsx, xls, ods, csv and tsv, with sheet tabs and large-sheet scrolling
- PowerPoint presentations (pptx): slides, shapes, tables, pictures and notes
- EPUB books with table of contents and text size
- Images: png, jpg, gif, webp, avif, bmp, svg and more, with zoom and rotate
- Audio and video, using your phone's own players
- Text, code, Markdown and JSON, with colour highlighting and line numbers
- ZIP and CBZ archives: browse the list and open any file inside
- Fonts, and a plain text or hex view for anything else

If a file cannot be displayed, UniView always offers "View as text" and "View as hex" instead of a blank screen.

OPEN FILES THE WAY YOU ALREADY DO
Tap a file in any app and choose UniView with "Open with", or use Share and "Send to UniView". Or open UniView and tap Open to pick a file. Several files open in tabs, like a browser.

PRIVATE BY DESIGN
- No account, no sign-in
- No ads, no analytics, no tracking, no crash-report uploads
- Files are never uploaded
- UniView has no servers of its own, so there is nothing to send your data to
- Documents are shown in a locked-down viewer: scripts inside documents do not run

BROWSE YOUR COMPUTER FROM YOUR PHONE (OPTIONAL)
Using UniView on Windows too? Pair your phone with your computer by scanning a QR code on the computer's screen. Then browse the folders you chose to share and open files on demand, even big videos, without copying them first.
- Off until you turn it on, and you pick the folders
- Read only: the phone cannot change, delete or upload anything
- Direct between your own devices over your own Wi-Fi, encrypted from end to end
- No relay, no server, no account
This is the only reason the app asks for network access, and it never contacts anything that is not on your local network. The camera is used only to scan the pairing QR code.

WORKS WITH AI ASSISTANTS (OPTIONAL)
If you use an AI coding assistant on your computer, UniView on Windows can show its reports and ask you to approve or reject its work. On the phone, review files open read-only; the decision is always made on the computer.

GOOD TO KNOW
- UniView is for viewing. It does not edit or annotate files.
- Charts and equations inside PowerPoint files appear as labelled placeholders.
- Old binary .doc and .ppt files show their recovered text only.
- Password-protected PDFs are not supported yet.
- HEIC photos are not supported.

UniView is free of ads and has nothing to sell you. Questions or feedback: [CONTACT EMAIL]
```

**[VERIFY]** Before publishing, confirm each listed format opens on a real Android device or the emulator. `README.md` states that Android runtime behaviour has not been verified on a device, and `docs/STATUS.md` says phone timings and real pairing still need the physical phone. Delete any line that fails. Do not add speed claims for the phone: only PC timings exist.

### Contact details (Play Console, Store settings)

| Field | Value |
|---|---|
| Email | `[CONTACT EMAIL]` |
| Website | `[WEBSITE]` (optional) |
| Phone | optional |
| Privacy policy URL | `[PRIVACY POLICY URL]` |

### Category and tags

| Field | Value |
|---|---|
| App or game | App |
| Category | **Productivity** (alternative: Tools) |
| Tags | Document viewer, File manager (choose the closest tags offered) |
| Free or paid | Free |
| Ads | No ads |
| In-app purchases | None |

**[VERIFY]** the exact category and tag names offered in Play Console.

---

## 2. Graphics

| Asset | Requirement | Source in this repo | Status |
|---|---|---|---|
| App icon | 512 x 512, 32-bit PNG with alpha, at most 1024 KB | `assets/branding/play-store-512.png` (512 x 512, RGBA PNG, 8,538 bytes) | Exists. It is the placeholder logo; replace after the CEO sends the final logo (`assets/branding/README.md` explains regeneration). |
| Feature graphic | 1024 x 500, PNG or JPEG, at most 15 MB | none | **Missing.** Create one (logo, name "UniView", tagline "Open any file. Offline, private, instant."). |
| Phone screenshots | 2 to 8; JPEG or 24-bit PNG; each side 320 to 3840 px; Hermes brief says 16:9 or 9:16 | none yet | **Missing**, see the checklist below. |
| 7-inch and 10-inch tablet screenshots | optional | none | Optional. |

### Screenshots checklist

Do not use `demo/shots/` as phone screenshots. Those are 1264 x 801 desktop captures made by `demo/rehearse.mjs`, and the folder is git-ignored (it exists only on the machine that ran the rehearsal). Use them only as a guide to what to show.

Capture at least these 5 phone screenshots (Play needs at least 2):

- [ ] 1. Home screen (drop zone, Open button, recent files with preview images)
- [ ] 2. A PDF open (use `demo/files/report.pdf`)
- [ ] 3. A spreadsheet open with sheet tabs (`demo/files/sales.xlsx`)
- [ ] 4. A presentation or Word document (`demo/files/deck.pptx` or `charter.docx`)
- [ ] 5. Connect-a-computer screen or the phone browsing a shared folder (needs the real phone and the PC; see "Part 3: phone" in `demo/DEMO.md`)
- [ ] 6. (optional) Several tabs open at once, or a code file (`demo/files/app.ts`)
- [ ] No personal names, email addresses, file names or folder paths in any screenshot
- [ ] Only the UniView logo, no Capacitor or third-party logos
- [ ] Each image: longer side at most 2 times the shorter side. The emulator below is 1080 x 2400 (ratio 2.22), which is too tall. Either set it to 1080 x 1920 (step 4) or crop.

### Emulator capture steps (Windows, PowerShell)

The Android SDK and an Android 34 emulator already exist under `I:\AES\Tools\android-sdk` (virtual device `BrainPal_Emulator`, 1080 x 2400). Do not use `BrainPal_ARM` (Android 25, below the app's minimum of Android 8.0 / API 26).

```powershell
$env:ANDROID_HOME     = 'I:\AES\Tools\android-sdk'
$env:ANDROID_AVD_HOME = 'I:\AES\Tools\android-sdk\.android\avd'
$env:PATH = "$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:PATH"
cd I:\Development\Clone\Universal\uniview

# 1. Build and install the debug app (JDK 21 required, see docs/RELEASE-CHECKLIST.md section 3)
$env:JAVA_HOME = 'I:\AES\Tools\jdk-21.0.12.1+1'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
npm run android:apk

# 2. Start the emulator (leave this window running), wait until the home screen shows
emulator -avd BrainPal_Emulator -no-snapshot

# 3. In a second window: install the app and push the demo files
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
adb push demo\files /sdcard/Download/uniview-demo
adb shell am start -n com.uniview.viewer/.MainActivity

# 4. Optional: make the screen 9:16 so screenshots fit Play's ratio rule. Undo it afterwards.
adb shell wm size 1080x1920

# 5. In the app tap Open, pick files from Downloads/uniview-demo, then capture each screen:
adb exec-out screencap -p > "$env:TEMP\shot-1-home.png"
#    (repeat with a new file name per screen; save finals in a folder you choose, for example I:\AES\Outputs)

# 6. Restore the emulator screen
adb shell wm size reset
```

Dark mode and light mode: capture all in one theme for a consistent listing. Turn on "Demo mode" or set the clock to 12:00 if the status bar looks noisy: `adb shell settings put global sysui_demo_allowed 1` **[VERIFY]**.

Check each file before upload: `Get-Item shot-*.png` for size and a quick look at dimensions (320 to 3840 px per side).

---

## 3. Content rating (IARC questionnaire)

Play Console: Policy, App content, Content rating, Start questionnaire. Enter the email `[CONTACT EMAIL]`.

| Question | Answer |
|---|---|
| App category | **Utility, Productivity, Communication, or Other** (not a game, not social, not a news app) |
| Violence (any kind, including cartoon) | No |
| Sexual content or nudity | No |
| Profanity or crude humour | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| Gambling or simulated gambling | No |
| Does the app let users communicate with each other or share user-generated content with other users? | No. (The optional pairing feature connects a person's own phone to their own computer. There are no other users, no chat and no public content.) |
| Does the app share the user's physical location with other users? | No |
| Does the app allow users to purchase digital goods? | No |
| Does the app provide unrestricted internet access or a web browser? | No. The app cannot browse the web, and its network use is limited to paired devices on the local network. |
| Is the app primarily directed at children? | No |

Expected result: lowest age band (for example ESRB Everyone, PEGI 3, IARC 3+). **[VERIFY]** the result shown at the end of the questionnaire.

---

## 4. Data safety form

Play Console: Policy, App content, Data safety.

### Overview questions

| Question | Answer | Reason (from the code) |
|---|---|---|
| Does your app collect or share any of the required user data types? | **No** | Nothing is sent to the developer or to any third party. There is no server, account, analytics, advertising or crash-report code (see `docs/PRIVACY.md`, internal verification table). |
| Is all of the user data collected by your app encrypted in transit? | Not applicable (no data is collected). If the console forces an answer: Yes. | The only network traffic is between the person's own paired devices, end-to-end encrypted with ECDH P-256, HKDF-SHA-256 and AES-256-GCM (`docs/REMOTE.md`). |
| Do you provide a way for users to request that their data be deleted? | Not applicable (no data is collected). If the console forces an answer: Yes. | No data is held by the developer. Users delete everything on their device with Clear storage or uninstall (`docs/PRIVACY.md`, "How to delete your data"). |
| Privacy policy URL | `[PRIVACY POLICY URL]` | `docs/PRIVACY.md`, published. |

### Data types (answer "not collected" and "not shared" for every category)

| Category | Collected | Shared | Why |
|---|---|---|---|
| Location | No | No | App never requests location. |
| Personal info (name, email, user IDs, address, phone) | No | No | No accounts or sign-in. |
| Financial info | No | No | No payments. |
| Health and fitness | No | No | Not used. |
| Messages | No | No | Not used. |
| Photos and videos | No | No | Files are opened on the device only and never sent anywhere. |
| Audio files | No | No | Same. |
| Files and docs | No | No | Same. Files are opened by the user and shown locally. |
| Calendar, contacts | No | No | Not accessed. |
| App activity (interactions, search history, installed apps) | No | No | The recent-files list is stored on the device only and never transmitted. |
| Web browsing | No | No | The app has no browser. |
| App info and performance (crash logs, diagnostics) | No | No | No crash reporter or diagnostics SDK. |
| Device or other IDs | No | No | No advertising ID, no analytics ID. |

### Why the INTERNET permission is not "collection"

`AndroidManifest.xml` declares `INTERNET` only so the phone can talk directly to the person's own computer over the local network (a code comment in the manifest says the same). The app only contacts private-network addresses (`LanUrl.java`) and the device name it sends during pairing goes only to the computer the person pairs with. Google defines "collect" as transmitting data off the device to the developer or a third party; this does not apply. The CAMERA permission only scans the pairing QR code on the device and no image is stored or sent.

**[VERIFY]** In Play Console, the explanation in the form can be left blank; keep this paragraph ready in case review asks. **[VERIFY]** that a transfer to the person's own computer needs no declaration under current Google wording.

### Other App content declarations

| Declaration | Answer |
|---|---|
| Ads | No, the app does not contain ads |
| App access | All functionality is available without login or special access |
| Target audience and content | **18 and over** is the simplest choice and avoids the Families policy. (A utility viewer is not aimed at children; 13+ is also defensible.) **[VERIFY]** with the CEO. |
| News app | No |
| COVID-19 contact tracing or status | No |
| Government app | No |
| Financial features | None |
| Health features | None |
| Advertising ID | The app does not use it. Declare "No". |
| Permissions declaration (sensitive permissions) | None needed: `INTERNET` and `CAMERA` are not restricted permissions. The app does **not** request all-files access (`MANAGE_EXTERNAL_STORAGE`). **[VERIFY]** that the console shows no declaration form. |
| Sensitive intent filter | The app accepts "Open with" and Share for any file type (`*/*`). This is its core purpose. |

---

## 5. Release setup in Play Console

- **Package name:** `com.uniview.viewer` (permanent once uploaded).
- **Upload format:** the signed Android App Bundle (`app-release.aab`). Build and signing steps: `docs/RELEASE-CHECKLIST.md`.
- **Play App Signing:** enrol when you create the first release. Keep the upload keystore safe. Details in the checklist.
- **Countries:** start with all countries or a short list; India, United States and United Kingdom are enough for the test.
- **Version:** `versionCode` 1, `versionName` 1.0. Every later upload needs a higher `versionCode`.

---

## 6. Closed-testing plan (12 testers x 14 days)

Rule (from Hermes brief, Decision 5): a **personal** developer account created after 13 November 2023 must run a closed test with **at least 12 testers opted in continuously for at least 14 days** before it can apply for production. Organization accounts are exempt. The 14-day clock restarts for a tester who opts out and back in. **[VERIFY]** the current rule and your account type in Play Console (Dashboard, "Test and release") before recruiting.

Plan for **16 to 20 testers** so that drop-outs do not stop the clock.

### Before you recruit

- [ ] Developer account paid ($25) and identity verified (CEO)
- [ ] Signed `app-release.aab` built and uploaded to a **Closed testing** release (see "Opt-in link steps")
- [ ] Store listing, content rating, Data safety and privacy policy completed so the release can be sent for review
- [ ] A Google Group or an email list ready (see below)
- [ ] The app tested at least once on a real phone by the team

### Opt-in link steps (Play Console)

1. Play Console, select UniView. Left menu: **Testing, Closed testing**.
2. Create a track (or use the default "Alpha") and choose **Create release**.
3. Upload `app-release.aab`. Accept Play App Signing if asked. Add release notes (for example "First test version of UniView"). Save, then **Next** and fix any errors shown.
4. **Testers** tab: create the list. Either
   - choose **Google Groups** and enter the group address `uniview-testers@googlegroups.com` (from the Hermes brief; create the group first at groups.google.com and set "Who can join" to invitation only or anyone with the link, and tell testers to join it), or
   - choose **Email lists**, create a list named "UniView testers" and paste the testers' Gmail addresses.
5. Set the **feedback email address** to `[CONTACT EMAIL]`.
6. **Save**, then **Send changes for review / Roll out to Closed testing**. Google reviews first, which can take from hours to a few days. **[VERIFY]**
7. After approval, on the Testers tab choose **Copy link** under "How testers join your test". The web opt-in link has the form `https://play.google.com/apps/testing/com.uniview.viewer` (from the Hermes brief). **[VERIFY]** by opening the link from a tester account.
8. Send the link with the message template below. Each tester:
   1. opens the link while signed in to the Google account that was added,
   2. taps **Become a tester**,
   3. taps the link to install from Google Play (it can take a few minutes to appear),
   4. keeps the app installed.
9. Watch **Testing, Closed testing, Testers** in the console every day. The count of opted-in testers must stay at 12 or more.

### Tester recruitment message (template)

> Subject: Help me test UniView on your Android phone (14 days, 5 minutes in total)
>
> Hi [NAME],
>
> I'm about to publish UniView, a free Android app that opens PDFs, Word, Excel and PowerPoint files, images, books and more, offline and with no account. Google requires 12 people to test it for 14 days before it can go public, and I'd really appreciate your help.
>
> What I need from you:
> 1. Reply with the **Gmail address** you use on your Android phone (it must be a Google account).
> 2. When I confirm, open this link on your phone and tap **Become a tester**, then install the app: [OPT-IN LINK]
> 3. **Keep the app installed until [END DATE: 15 days after you reach 12 testers].** Please don't uninstall it or leave the test, because that restarts the 14-day count for everyone.
> 4. Once or twice during the test, open the app and try: (a) open a PDF, (b) open an Excel or CSV file, (c) if you have a Windows PC: pair your phone with it over your home Wi-Fi.
> 5. If anything looks wrong, reply with a screenshot or message me at [CONTACT EMAIL].
>
> Nothing is collected: the app has no ads, accounts or tracking. Privacy policy: [PRIVACY POLICY URL].
>
> Thank you,
> [NAME]

Recruitment pool (from the Hermes brief): final-year cohort at COEP (College of Engineering Pune), student tech clubs and the developer peer network. Collect Gmail addresses in a private spreadsheet; do not post addresses publicly.

### Retention protocol (14 days)

| Day | Action |
|---|---|
| Day 0 | Roll out the closed test. Send opt-in messages. Record the date when the console first shows 12 or more opted-in testers: the 14 days count from there. |
| Day 1 to 3 | Chase testers who have not opted in. Add more people until at least 16 have opted in. |
| Day 3, 7, 10 | Send a short reminder with the 3-item task list (open a PDF, open an Excel sheet, pair with a PC on Wi-Fi). Ask for feedback. |
| Every day | Check the opted-in count. If it falls below 12, recruit replacements immediately; note that a replacement's own 14 days start only when they join. |
| Day 14 | Ask testers to stay one more day. |
| Day 15 | Open the production-access application in Play Console (Dashboard, "Apply for production" or the production access questionnaire). Answers to prepare: how you recruited testers, how many and how engaged, what feedback you received, what you fixed, why the app is ready. **[VERIFY]** the questions shown at that time. |
| After approval | See "After Play's 14 days" in `docs/RELEASE-CHECKLIST.md`. |

Keep a log of tester feedback and the fixes made, because the production-access form asks for them.
