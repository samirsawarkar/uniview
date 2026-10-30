# Free release guide (unsigned builds, draft GitHub release)

This is the zero-cost way to get UniView builds onto GitHub and into people's hands. It costs nothing: no certificate, no store account, no keystore. The price is that the files are **unsigned**, so Windows shows a warning and Android needs one extra step. Section 5 explains what that means for a user, and section 7 describes a free way to get Windows signing later.

It fits next to the paid route already decided in `docs/CEO-DECISIONS.md` (Decision 4: an OV cloud-signing certificate, about $250 a year) and `docs/RELEASE-CHECKLIST.md` (Phase 3 and Phase 8 step 6). Nothing here replaces those; it is the free first step. The workflow is `.github/workflows/release.yml`.

**[VERIFY]** marks anything that could not be confirmed from this repository and must be checked on the official site when you act on it.

---

## 1. Before you run it

1. The code is pushed to GitHub and the `CI` workflow is green on the commit you want to release (`docs/RELEASE-CHECKLIST.md`, Phase 6). The release workflow does not run the tests; it only builds.
2. The version is bumped everywhere (`docs/RELEASE-CHECKLIST.md`, Phase 2). The workflow stops at the start if the tag you type is not `v` plus the version in `package.json` (for example `v1.0.0` for version `1.0.0`), because the Windows file names come from that version.
3. The workflow file is on the repository's default branch. GitHub only shows the "Run workflow" button for workflows that exist on the default branch.

## 2. Run the workflow

In the browser:

1. Open the repository on GitHub, then the **Actions** tab.
2. In the left list choose **Release (manual, unsigned)**.
3. Press **Run workflow**. Under "Use workflow from" pick the branch to build (for example `feat/v1-core` or `main`).
4. Type the tag, for example `v1.0.0`, and press the green **Run workflow** button.
5. Wait. Expect roughly 15 to 40 minutes. **[VERIFY]** the first run: the Android part has never run on a GitHub runner before. If it fails at the Gradle step, the log says why (the most likely cause is an Android SDK platform that the runner image does not have).

Or from a terminal with the GitHub CLI: `gh workflow run release.yml --ref main -f tag=v1.0.0`.

What it does: builds the Windows installer and portable exe, builds an Android debug APK and an unsigned release APK, writes `SHA256SUMS.txt`, saves everything as a workflow artifact called `uniview-release-unsigned` (kept 30 days), then creates a **draft** release for the tag. A draft is private to people who can write to the repository. Nothing is published and no tag exists until you publish the draft.

## 3. Download the draft release

1. Repository page, **Releases** (right-hand side), or `https://github.com/<owner>/<repo>/releases`. The draft is at the top, marked **Draft**, titled `UniView <tag> (unsigned)`.
2. Attached files:

   | File | What it is |
   |---|---|
   | `UniView-Setup-<version>.exe` | Windows installer (per-user, no admin needed) |
   | `UniView-Portable-<version>.exe` | Windows single file, runs without installing |
   | `UniView-<tag>-android-debug.apk` | Android app signed with Android's public debug key. This is the one to install on a phone. |
   | `UniView-<tag>-android-release-unsigned.apk` | Android app with no signature at all. A phone will not install it as it is. For people who sign it themselves, and as the input for a store build. |
   | `SHA256SUMS.txt` | The expected SHA-256 of every file above |

3. The same files are also in the run page, under **Artifacts**, as one zip (`uniview-release-unsigned`).
4. Test the files yourself (Windows install, open some documents, install the APK on a phone; `docs/RELEASE-CHECKLIST.md`, Phase 5.4). When you are happy, press **Edit** on the draft, tidy the notes, and press **Publish release**. Publishing creates the tag and makes the files public. If anything is wrong, delete the draft and run the workflow again; you cannot reuse a tag that already has a release.

## 4. What the workflow does not do

- It signs nothing and uses no secret. The only token is GitHub's built-in one, and only the last job (creating the draft) can write to the repository.
- It does not build an Android App Bundle (`.aab`) for Google Play. Play needs a signed bundle (`docs/RELEASE-CHECKLIST.md`, Phase 4).
- It does not build macOS or Linux versions.

## 5. What "unsigned" means to a user

A signature is a stamp that says "this file really comes from this publisher and nobody changed it". An unsigned file has no stamp, so the operating system cannot vouch for it. The file is not necessarily bad; the system just does not know.

### Windows: SmartScreen

When a user starts the installer, Windows may show a blue window: **"Windows protected your PC. Microsoft Defender SmartScreen prevented an unrecognized app from starting."** (`docs/CEO-DECISIONS.md`, Decision 4). To go on:

1. Click **More info** (a small link in the message).
2. Click the **Run anyway** button that appears.

Only do this if you downloaded the file from the project's own GitHub release page and its SHA-256 matches (next section). Signed files also show a warning until the publisher has built reputation through downloads, so even the paid certificate does not remove this at the start (`docs/CEO-DECISIONS.md`, Decision 4; `docs/RELEASE-CHECKLIST.md`, step 3.5).

### Check the SHA-256 of a download

The checksum is a fingerprint of the file. If one byte differs, the fingerprint differs. In PowerShell, in the folder with the downloads:

```powershell
Get-FileHash .\UniView-Setup-1.0.0.exe -Algorithm SHA256
```

Compare the `Hash` it prints with the line for that file in `SHA256SUMS.txt` (upper or lower case does not matter). They must be identical. If not, delete the file and download it again from the release page. To check every file at once on a Mac or Linux machine: `sha256sum -c SHA256SUMS.txt`.

A checksum only proves the file matches what was published. If someone replaced both the file and `SHA256SUMS.txt` on the page, it proves nothing. A signature from a certificate authority proves more; that is what section 7 and the paid certificate are for.

### Android: install the APK (sideload)

"Sideload" means installing an app from a file instead of from Google Play.

1. On the phone, download `UniView-<tag>-android-debug.apk` from the release page (browser) or copy it over from a PC.
2. Open it from the Downloads app or the browser. Android asks to allow installs from that app (for example Chrome or Files). Allow it. On recent Android this is **Settings, Apps, Special app access, Install unknown apps**. The wording differs by phone and Android version. **[VERIFY]** on the test phone.
3. Press **Install**. If Google Play Protect warns about an unrecognised app, choose to install anyway. **[VERIFY]** the wording on the test phone.
4. Turn the "Install unknown apps" permission off again afterwards.
5. Updating: install a newer APK over the old one. A debug build and a later properly signed build use different signatures, so Android will refuse to install one over the other; uninstall first (this removes the app's data).

The **release** APK is unsigned. A phone refuses to install an unsigned APK. It only becomes installable after signing, for example with `apksigner` from the Android SDK and a keystore the CEO controls (`docs/RELEASE-CHECKLIST.md`, step 4.2). The debug APK is what testers should use. It is a debug build, so it is not what the Play Store or F-Droid would ship.

Android runtime behaviour has not been verified on a physical device (`README.md`, Known limits). Treat the first sideload as a test.

---

## 6. Where this fits in the larger plan

| Step | Free route (this file) | Paid / store route (existing docs) |
|---|---|---|
| Windows download | Unsigned exe on the draft release; users click "Run anyway" | OV cloud-signing certificate, `docs/RELEASE-CHECKLIST.md` Phase 3 |
| Android download | Debug APK, sideload | Play closed test and production, Phase 7 and 8 |
| Trust | SHA-256 list | Signature plus the same list |

---

## 7. Free code signing for open-source projects

This section describes an **option**, not a decision. It does not change the recommendation in `docs/CEO-DECISIONS.md` Decision 4 (buy an OV cloud-signing certificate). It is a possible free alternative for the Windows files if the project is open source and is accepted.

The programme is the **SignPath Foundation** free code signing for open-source projects (the Foundation is the non-profit side of SignPath, a code-signing service). Everything below was read from SignPath's public terms page at the time this file was written and is **not guaranteed current**. Read the official pages (start at `https://signpath.org`) before relying on any of it.

### What is claimed about the programme (every item to be checked)

- It gives open-source projects a code-signing certificate and signing service at no charge. **[VERIFY]**
- The signed certificate belongs to the SignPath Foundation, so Windows shows the Foundation as the publisher, not the project owner's name. **[VERIFY]**
- The project must use an OSI-approved open-source licence, with no commercial dual-licensing and no proprietary code in the project. **[VERIFY]**
- The project must be actively maintained and already released in the form to be signed, with its functionality described on a download page. **[VERIFY]**
- Whether the source repository must be **public** is not stated on the page that was read; assume yes (the signed build has to be verifiable from public source). **[VERIFY]**
- The team that signs must also develop the project and own its source repository, and only binaries built from the project's own source may be signed. **[VERIFY]**
- The binaries must be built from source by an automated build (CI), in a way that can be verified. SignPath works with common CI systems, including GitHub Actions. Whether the current workflow style (build job, then a signing request) is accepted is for SignPath to confirm. **[VERIFY]**
- Every release needs a manual approval of the signing request by a named approver, and the team members need multi-factor authentication on SignPath and on the repository. **[VERIFY]**
- The project must publish a "Code signing policy" page (on its home page and download pages) with the attribution text SignPath specifies, the team roles, and a privacy statement. **[VERIFY]**
- Installers must offer an uninstall route and must be honest about data collection. **[VERIFY]**
- **Application:** the project applies through a form on SignPath's site. Acceptance is at SignPath's discretion after a check of the project; there is no fixed public list of reputation criteria and no appeal. **[VERIFY]**
- **Reputation:** SignPath checks the project's standing and the owner's control of the repository before accepting. How new, small or one-person projects are judged is not published. UniView has no public history yet, so acceptance is uncertain. **[VERIFY]**
- Whether an applicant based in India is eligible is not stated on the page that was read. (Azure Artifact Signing is not available to India-based developers; `docs/CEO-DECISIONS.md`, Decision 4. That restriction is Microsoft's and does not necessarily apply here.) **[VERIFY]**
- Signed files may still trigger SmartScreen until reputation builds; the programme does not promise otherwise. Consistent with the existing docs, assume the same slow ramp as with a paid certificate. **[VERIFY]**
- Terms, requirements and the Foundation's own conditions can change; the terms page itself says some parts (for example its code of conduct) are drafts. **[VERIFY]**

### Checklist to prepare (CTO, before the CEO applies)

- [ ] **Public repository.** The repository is currently planned as private (`docs/RELEASE-CHECKLIST.md`, Phase 6). Making it public is a CEO decision. First run the secrets scan from Phase 1 step 6 over the whole history, because making it public exposes every commit. Also decide about the three tracked leftover `*.receipt.json.decision.json` files (Phase 1 step 3).
- [ ] **LICENSE present (MIT).** Done: `LICENSE` (MIT, copyright 2026 Samir Sawarkar) and `"license": "MIT"` in `package.json`. Check that no dependency makes the project non-open (no proprietary code, no dual commercial licence).
- [ ] **THIRD_PARTY_NOTICES.** Done: `THIRD_PARTY_NOTICES.md`. Re-check that it matches `package.json` at release time. Open question: the `xlsx` package is fetched from `cdn.sheetjs.com`, not the npm registry; confirm its licence line is right.
- [ ] **README.** Done: `README.md`. Add a download section that describes what the app does (SignPath asks for a description on the download page), links to the privacy policy (`docs/PRIVACY.md`, needs a public URL; `[PRIVACY POLICY URL]` is still a placeholder) and has the "Code signing policy" text once SignPath gives the exact wording.
- [ ] **CI build reproducible.** The Windows build must come from a GitHub Actions run on the public repository, from a clean checkout with `npm ci` (the lock file pins every dependency). `release.yml` does this. SignPath will want the signing request to come from that run, not from a file uploaded from a PC. That needs a small workflow change after acceptance. **[VERIFY]**
- [ ] **At least one real public release** (an unsigned one from section 2 is fine) so there is something "released in the form to be signed". **[VERIFY]**
- [ ] **Roles and security.** The CEO decides who is author, reviewer and approver (probably the CEO alone), and turns on two-factor authentication on GitHub and SignPath. **[VERIFY]**
- [ ] **Contact email** (`docs/RELEASE-CHECKLIST.md`, Phase 0.5) ready to give on the application.

### The manual step only the CEO can do

**Apply on SignPath's site.** Open the open-source application page linked from `https://signpath.org` **[VERIFY the exact page]**, fill in the form with the public repository URL, the licence, the project description and the contact details, and submit it. This needs the CEO's identity and acceptance of SignPath's terms, so no agent or script can or should do it. After that SignPath replies; the next steps (creating the project in SignPath, connecting GitHub Actions, naming the approver, adding the signing step to the workflow) are described by SignPath and become a small CTO task. **[VERIFY]** There is no step to run in this repository for the application itself.

Until the answer arrives, keep using the unsigned route in this file. If SignPath says no, the paid route in `docs/CEO-DECISIONS.md` Decision 4 stays as written.

### F-Droid: an optional free store for the Android build

F-Droid is a free app store for open-source Android apps. It builds each app itself from the public source, signs it with its own key, and users get it through the F-Droid app. **[VERIFY]**

- It only takes apps whose source is public and fully free software, and it rejects apps with non-free dependencies or certain tracking and proprietary services. UniView has no analytics and is MIT, which is a good starting point; the Capacitor and AndroidX dependencies still have to be checked against F-Droid's inclusion policy. **[VERIFY]**
- Adding an app means opening a merge request with a metadata file in F-Droid's data repository; volunteers review it, and it can take weeks. There is no fee. **[VERIFY]**
- The F-Droid build is made from source by F-Droid, so it does not use the APKs from this workflow, and users get a different signing key than a Play Store or sideloaded build. They cannot update one over the other. **[VERIFY]**
- This is optional and independent of Google Play (`docs/RELEASE-CHECKLIST.md`, Phase 7 and 8). Do not start it before the repository is public and a tagged release exists. **[VERIFY]**
