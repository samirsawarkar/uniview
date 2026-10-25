# UniView release checklist

Exact, ordered steps from "code is ready" to "people can install it". Each step is tagged **[CEO]** (needs an account, money, identity or a decision) or **[CTO]** (technical, can be done by Claude and the agents). Nothing in this file has been run for you: no account exists, nothing has been pushed, no certificate or key has been created.

Conventions:

- **[VERIFY]** marks anything that could not be confirmed from this repository and must be checked when you do the step.
- Commands are PowerShell, run from `I:\Development\Clone\Universal\uniview` unless stated.
- **No secret ever goes into the repository.** Passwords, certificates, keystores and API keys live in environment variables of the current shell, GitHub Actions secrets, or a folder outside every git working tree. Section 1 adds the ignore rules that make an accidental commit harder.

Sources: `docs/CEO-DECISIONS.md` (Hermes briefs: Decision 4 code signing, Decision 5 Google Play, Decision 6 GitHub and CI), `docs/STATUS.md`, `README.md`, `electron-builder.json`, `package.json`, `android/app/build.gradle`, `capacitor.config.json`.

Current state (from `package.json` and `android/app/build.gradle`): version `1.0.0`, Android `versionCode 1`, `versionName "1.0"`, `minSdk 26`, `targetSdk 36`, Electron 45.0.0, electron-builder 26.15.3, `appId` and package `com.uniview.viewer`.

---

## Phase 0: what the CEO must do first (long lead times)

These take days, so start them now. Everything else can proceed while they wait.

| # | Owner | Action | Lead time | Why |
|---|---|---|---|---|
| 0.1 | CEO | Buy a **Windows OV code-signing certificate with cloud signing**: SSL.com (eSigner) is the first choice; Sectigo is the alternative (Hermes brief, Decision 4: about $250 a year, 2 to 4 business days). Start the identity verification (passport or Aadhaar plus a short video or notary check for an individual; registration documents for a business). | 2 to 4 days after verification | Installers are unsigned until then. Azure Artifact Signing is not available to India-based developers (Hermes brief). An EV certificate is not needed: SmartScreen treats EV and OV the same since 2024 (Hermes brief). **[VERIFY]** the current price and process on the provider site. |
| 0.2 | CEO | Create the **Google Play Console personal developer account** ($25) and finish ID verification. Create a Google Group for testers, for example `uniview-testers@googlegroups.com`. | Days | Needed for the 14-day closed test. |
| 0.3 | CEO | Decide: **GitHub Pro (about $4 a month)** for branch protection on a private repository, or stay on Free with team discipline. | Minutes | Free private repositories cannot enforce branch protection (Hermes brief). |
| 0.4 | CEO | Send the **final logo** (SVG or 1024 x 1024 PNG) when ready. The current blue-eye icon is a placeholder. Regeneration steps: `assets/branding/README.md`. | Anytime before the public release | Store icons are locked to the logo. Do not start the Play closed test with a logo you will change if you can avoid it. |
| 0.5 | CEO | Give a **contact email** and (optionally) a website, and decide where the privacy policy will be hosted publicly. | Minutes | Fills `[CONTACT EMAIL]` and `[PRIVACY POLICY URL]` in `docs/PRIVACY.md` and `docs/play-store-listing.md`. |

---

## Phase 1: prepare the repository and verify the code [CTO]

1. **Add secret-file ignore rules** so a certificate or keystore cannot be committed by accident. The repository's `.gitignore` is extended with `*.jks`, `*.keystore`, `keystore.properties`, `*.pfx`, `*.p12`, `*.pem`, `.env` and `.env.*` (done in the commit that added this file).
2. **Check the working tree**: `git status`. Several untracked folders exist (`.aes/`, `release-final/`, `.host-driver.mjs`, `.pc.mjs`). Never use `git add .` or `git add -A`; add explicit paths.
3. **Observation** (not changed here): the repository root contains three tracked files `a.receipt.json.decision.json`, `b.receipt.json.decision.json` and `r.receipt.json.decision.json`. They look like leftovers from review tests. Decide whether to delete them before the first push.
4. **Run the full local check** (the same sequence CI runs, `.github/workflows/ci.yml`):

   ```powershell
   npm ci
   node scripts/copy-assets.mjs
   npm run fixtures
   npx tsc --noEmit -p .
   npx vitest run
   npx vite build
   npx playwright install chromium
   npx playwright test --project=web --project=mobile
   npx playwright test --project=electron
   ```

   Expected (`docs/STATUS.md`): type check clean, 1393 unit and integration tests, 52 web and phone-size tests, 4 Electron tests. **[VERIFY]** the counts: STATUS.md is dated 2026-10-26 and may be out of date.
5. **Re-run the independent code review** (Codex) on the final code after any change made since `73ed049`. `docs/STATUS.md` lists this as the rule.
6. **Secrets scan before the first push** (nothing has ever been pushed, so the whole history becomes public to GitHub): search all history for key material.

   ```powershell
   git log --all --oneline | Measure-Object
   git grep -nI -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|storePassword|keyPassword|CSC_KEY_PASSWORD=" $(git rev-list --all) | Select-Object -First 20
   ```

   Review any hit. **[VERIFY]** this pattern is enough; if `gitleaks` is installed, run it instead.

---

## Phase 2: version bump [CTO]

Change the version in **all** these places, in one commit, before building anything for release:

| File | What to change |
|---|---|
| `package.json` | `"version"` (currently `1.0.0`) |
| `package-lock.json` | the top-level `"version"` and the `""` package entry `"version"` (lines 3 and 9). Easiest: `npm version 1.0.1 --no-git-tag-version`, which updates both files |
| `android/app/build.gradle` | `versionCode` (a whole number, **must increase by at least 1 for every Play upload**, currently `1`) and `versionName` (currently `"1.0"`) |
| `ios/App/App.xcodeproj/project.pbxproj` | `MARKETING_VERSION` (two entries, currently `1.0`) and `CURRENT_PROJECT_VERSION` (two entries, currently `1`), only if you ship iOS |
| `README.md` | the example installer names in the Packages table (lines 59 and 60 say `1.0.0`) |
| `electron-builder.json` | nothing: installer names use `${version}` and come from `package.json`. The `copyright` line says 2026 |

Check afterwards: `Select-String -Path package.json,android\app\build.gradle -Pattern 'version'` and build once to confirm the file names (Phase 4).

---

## Phase 3: Windows code signing

### 3.1 Which route (decision from the Hermes brief)

Recommendation in `docs/CEO-DECISIONS.md` Decision 4: **OV certificate with cloud signing (SSL.com eSigner, or Sectigo)**, signed from a script that electron-builder calls for every file. Reasons in the brief: the CA/Browser Forum rule since 2023 puts the key on hardware or a cloud HSM, so you normally receive **no `.pfx` file**; Azure Artifact Signing is not available in India.

Consequence for the "CSC_LINK / CSC_KEY_PASSWORD" approach you may have heard about: those variables only work when the CA gives you an exportable `.pfx` file. With cloud signing they do **not** apply, and the route is the custom `sign` script below (3.3). Both routes are written down so you can pick the one your certificate allows.

### 3.2 Collect the credentials (CEO, in the provider's portal; never paste them into chat or a file in the repo)

For **SSL.com eSigner** the signing tool (CodeSignTool) needs four values: account username, account password, the credential ID of your certificate, and the TOTP secret you get when you enrol the eSigner two-factor app. **[VERIFY]** these names and flags in SSL.com's current CodeSignTool documentation.

For **Sectigo**, the Hermes brief names "KeyLocker" and the `smctl` tool. As far as I know `smctl`/KeyLocker are DigiCert products, not Sectigo's. **[VERIFY]** which signing client Sectigo gives you before buying; if it differs, adapt the script in 3.3 to call that client.

Where the values live:

| Where | How |
|---|---|
| Your own machine | Environment variables of the PowerShell window that runs the build; closed when the window closes. Nothing written to disk. |
| GitHub Actions (later) | Repository **Settings, Secrets and variables, Actions, New repository secret**. The Hermes brief proposes `WINDOWS_SIGN_KEY_ID` and `WINDOWS_SIGN_SECRET`; for eSigner you need four, for example `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET`. **[VERIFY]** the names against the provider's documentation. |

### 3.3 Wire it into electron-builder (CTO, after the certificate is issued)

The keys below were checked against the installed electron-builder 26.15.3 schema (`node_modules/app-builder-lib/scheme.json`): `win.signtoolOptions` (with `sign`, `signingHashAlgorithms`, `publisherName`, `certificateFile`, `certificatePassword`, `certificateSha1`, `certificateSubjectName`, `rfc3161TimeStampServer`), `win.azureSignOptions`, `win.forceCodeSigning`, `win.signExts`, `win.signExecutable`, `win.cscLink`, `win.cscKeyPassword`. In version 26 the old top-level `win.sign` and `win.certificateFile` moved under `signtoolOptions`. The environment variable names `WIN_CSC_LINK` / `CSC_LINK` and `WIN_CSC_KEY_PASSWORD` / `CSC_KEY_PASSWORD` were confirmed in `app-builder-lib/out/winPackager.js` and `codeSign/windowsSignToolManager.js`.

**Add the `signtoolOptions` entry to the existing `"win"` object in `electron-builder.json`** (the rest of the object is shown unchanged for context; do not add secrets, only the script path):

```json
"win": {
  "icon": "build/icon.ico",
  "target": [ { "target": "nsis", "arch": ["x64"] }, { "target": "portable", "arch": ["x64"] } ],
  "signtoolOptions": {
    "sign": "./scripts/sign-windows.cjs",
    "signingHashAlgorithms": ["sha256"]
  }
}
```

Notes:

- The script must be `.cjs` because `package.json` has `"type": "module"`.
- Do **not** set `"forceCodeSigning": true` in the shared file: it would make every unsigned developer build and the unsigned CI job fail. For a real release add it on the command line instead (step 3.4).
- `publisherName` is optional (used only for update-signature checks; UniView has no updater). If you add it, copy the certificate's common name exactly. **[VERIFY]**

**Create `scripts/sign-windows.cjs`** (draft; check the CodeSignTool flags against SSL.com's documentation before use). electron-builder calls it once per file (the app exe, the installer, the uninstaller) with `configuration.path` set to the file; the script signs that file in place:

```js
// scripts/sign-windows.cjs: called by electron-builder for each Windows file to sign.
// Reads credentials from environment variables only. Never commit a value.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function sign(configuration) {
  const need = ["ES_USERNAME", "ES_PASSWORD", "ES_CREDENTIAL_ID", "ES_TOTP_SECRET", "CODESIGNTOOL_DIR"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`[sign] skipped (unsigned build): missing ${missing.join(", ")}`);
    return;
  }
  const file = configuration.path;
  const tool = path.join(process.env.CODESIGNTOOL_DIR, "CodeSignTool.bat");
  const r = spawnSync(
    tool,
    [
      "sign",
      `-username=${process.env.ES_USERNAME}`,
      `-password=${process.env.ES_PASSWORD}`,
      `-credential_id=${process.env.ES_CREDENTIAL_ID}`,
      `-totp_secret=${process.env.ES_TOTP_SECRET}`,
      `-input_file_path=${file}`,
      "-override=true",
    ],
    { stdio: "inherit", shell: true, cwd: process.env.CODESIGNTOOL_DIR },
  );
  if (r.status !== 0) throw new Error(`[sign] CodeSignTool failed for ${file} (exit ${r.status})`);
};
```

**[VERIFY]** (1) CodeSignTool's exact flags, in particular `-override` and whether an output folder is required; (2) that electron-builder accepts `exports.default` from a module path (documented for the custom `sign` option); (3) CodeSignTool needs Java: use the same JDK as for Android (Phase 5); (4) command-line arguments can be seen in the process list on the build machine, which is acceptable for your own PC or a throw-away GitHub runner. Test with one real build and `Get-AuthenticodeSignature` (3.5) before relying on it.

**If the CA does give you an exportable `.pfx`** (route B): no script is needed. Set, in the build window only:

```powershell
$env:WIN_CSC_LINK = 'C:\path\outside\the\repo\uniview-codesign.pfx'   # or a base64 string, or an https URL
$env:WIN_CSC_KEY_PASSWORD = Read-Host 'certificate password'
```

(`CSC_LINK` and `CSC_KEY_PASSWORD` also work and apply to every platform; the `WIN_` prefixed names apply to Windows only.) Remove the `signtoolOptions.sign` line in that case. **If you hold a hardware token**, use `win.signtoolOptions.certificateSubjectName` or `certificateSha1` with the token plugged in; the build prompts for the PIN.

### 3.4 Build the signed installer [CTO]

```powershell
npm ci
# set the provider variables for THIS window only (values from the provider portal, typed or pasted, never saved in a file):
$env:ES_USERNAME = '...' ; $env:ES_PASSWORD = '...' ; $env:ES_CREDENTIAL_ID = '...' ; $env:ES_TOTP_SECRET = '...'
$env:CODESIGNTOOL_DIR = 'I:\AES\Tools\CodeSignTool'     # wherever the tool is unpacked
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'              # do not hunt for a certificate in the Windows store
# release build: the extra argument is appended to the electron-builder command and refuses to produce an unsigned file
npm run dist:win -- -c.win.forceCodeSigning=true
```

The `-c.win.forceCodeSigning=true` form is electron-builder's command-line override for a config key. **[VERIFY]** it is accepted by 26.15.3.

`npm run dist:win` runs `npm run build` (type check and Vite build) and then `electron-builder --win --config electron-builder.json`. Output goes to `release\` (git-ignored): `UniView-Setup-<version>.exe` (installer) and `UniView-Portable-<version>.exe`, plus `release\win-unpacked\UniView.exe`. File names come from `nsis.artifactName` and `portable.artifactName` in `electron-builder.json`.

### 3.5 Verify the signature

```powershell
Get-AuthenticodeSignature release\UniView-Setup-1.0.0.exe, release\UniView-Portable-1.0.0.exe, release\win-unpacked\UniView.exe |
  Format-List Path, Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

Every file must show `Status : Valid` and a timestamp certificate. `Status : NotSigned` means the script was skipped (missing variables) or never called. The SDK's `signtool verify /pa /v <file>` gives the same answer. **Expect SmartScreen to still warn** until the certificate has built reputation through downloads (Hermes brief); an OV certificate and an EV certificate behave the same.

If you later become eligible for Azure Artifact Signing (a US/Canada/EU/etc. legal entity), the schema key is `win.azureSignOptions` instead of `signtoolOptions`; the two cannot be combined.

### 3.6 CI signing (optional, later)

`.github/workflows/ci.yml` builds only an **unsigned** installer (manual `workflow_dispatch`) and uses no secrets. To sign in CI, a separate job in a protected GitHub **Environment** (named, for example, `release`, with required reviewers) can read the four secrets and run `npm run dist:win`. This needs a CodeSignTool download step. It is a small CTO task once the secret names are fixed. Prefer signing on your own PC for the first release.

---

## Phase 4: Android build and signing

### 4.1 JDK 21 is required

`android/app/capacitor.build.gradle` sets Java 21 source and target compatibility, and `README.md` says "JDK 21". The shell on this PC defaults to JDK 17 (`JAVA_HOME` is `C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot`), which fails the build. JDK 21 is already installed at `I:\AES\Tools\jdk-21.0.12.1+1`. Set it for the window:

```powershell
$env:JAVA_HOME   = 'I:\AES\Tools\jdk-21.0.12.1+1'
$env:ANDROID_HOME = 'I:\AES\Tools\android-sdk'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version      # must report 21
```

The SDK location is also recorded in the git-ignored `android\local.properties` (`sdk.dir=I\:/AES/Tools/android-sdk`). On a different machine set `ANDROID_HOME` or create that file. Gradle 8.14.3 (wrapper) and Android Gradle Plugin 8.13.0 are used.

### 4.2 Generate the upload keystore (once, CEO present for the passwords)

Create a folder **outside every git working tree** (check with `git -C <folder> rev-parse` — it must fail), for example `I:\Secure\uniview`. Then:

```powershell
New-Item -ItemType Directory -Force I:\Secure\uniview | Out-Null
keytool -genkeypair -v -storetype PKCS12 `
  -keystore I:\Secure\uniview\uniview-upload.jks `
  -alias uniview-upload -keyalg RSA -keysize 2048 -validity 10000
```

`keytool` asks for a keystore password, a key password and your name and organisation details. Choose strong passwords yourself and store them in a password manager. **Never put the file or the passwords in the repository, chat, or an issue.** Make two backups of the `.jks` file (password manager attachment and an offline USB drive). If you lose the upload key you must ask Google Play support to reset it, which takes days. Validity of 10000 days is about 27 years (Google asks for a key valid well beyond 2033). **[VERIFY]** current Play requirements for key validity.

### 4.3 Make Gradle sign release bundles [CTO]

`android/app/build.gradle` currently has no `signingConfigs` block, so `bundleRelease` produces an **unsigned** bundle (an unsigned `app-release.aab` already exists from an earlier build). Add this to `android/app/build.gradle` (a build-file change, not yet made). It reads four values from Gradle properties **or** environment variables, so nothing secret is in the repository:

```groovy
android {
    // ... existing namespace, compileSdk, defaultConfig ...

    signingConfigs {
        release {
            def storePath = findProperty("UNIVIEW_UPLOAD_STORE_FILE") ?: System.getenv("UNIVIEW_UPLOAD_STORE_FILE")
            if (storePath) {
                storeFile file(storePath)
                storePassword (findProperty("UNIVIEW_UPLOAD_STORE_PASSWORD") ?: System.getenv("UNIVIEW_UPLOAD_STORE_PASSWORD"))
                keyAlias      (findProperty("UNIVIEW_UPLOAD_KEY_ALIAS")      ?: System.getenv("UNIVIEW_UPLOAD_KEY_ALIAS"))
                keyPassword   (findProperty("UNIVIEW_UPLOAD_KEY_PASSWORD")   ?: System.getenv("UNIVIEW_UPLOAD_KEY_PASSWORD"))
            }
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
            if (signingConfigs.release.storeFile != null) {
                signingConfig signingConfigs.release
            }
        }
    }
}
```

Supply the values in the build window (nothing stored):

```powershell
$env:UNIVIEW_UPLOAD_STORE_FILE     = 'I:\Secure\uniview\uniview-upload.jks'
$env:UNIVIEW_UPLOAD_KEY_ALIAS      = 'uniview-upload'
$env:UNIVIEW_UPLOAD_STORE_PASSWORD = Read-Host 'store password'
$env:UNIVIEW_UPLOAD_KEY_PASSWORD   = Read-Host 'key password'
```

Alternative: put the same four `UNIVIEW_UPLOAD_*` names in a `gradle.properties` inside your **Gradle user home** (`$env:GRADLE_USER_HOME\gradle.properties`, for example `I:\AES\Data\gradle\gradle.properties`), never in `android\gradle.properties`, which is tracked by git. **[VERIFY]** the snippet with a real build: a missing or wrong value must fail loudly or leave the bundle unsigned, and Step 4.5 must show a valid signature.

### 4.4 Build the release bundle

The order (each step feeds the next). `npm run cap:sync` is `npm run build && cap sync android` (type check, web build, copy `dist\` into the Android project):

```powershell
cd I:\Development\Clone\Universal\uniview
npm ci
npm run cap:sync
cd android
.\gradlew.bat bundleRelease
cd ..
```

Output: `android\app\build\outputs\bundle\release\app-release.aab`. For installing on a phone or the emulator use the debug build instead: `npm run android:apk` produces `android\app\build\outputs\apk\debug\app-debug.apk`.

Do not edit `capacitor.config.json` for release: it already has `webContentsDebuggingEnabled: false`, `allowMixedContent: false` and the Capacitor HTTP plugin disabled.

### 4.5 Verify the bundle is signed

```powershell
jarsigner -verify -verbose -certs android\app\build\outputs\bundle\release\app-release.aab
keytool -printcert -jarfile android\app\build\outputs\bundle\release\app-release.aab
```

`jarsigner` must say `jar verified`, and the certificate must be your upload certificate (compare its SHA-256 fingerprint with `keytool -list -v -keystore ...`). A warning about "unsigned" or "no manifest" means signing did not happen.

### 4.6 Play App Signing enrollment [CEO in Play Console, guided by CTO]

1. Play Console, create the app (name, language, free, Declarations).
2. When you create the first release (Testing, Closed testing, Create release), Play shows **Play app signing**. Accept it (it is mandatory for new apps; Hermes brief). Choose **Use a Google-generated key**.
3. Upload `app-release.aab`, which is signed with your **upload key**. Google keeps the **app signing key** and re-signs what it delivers. You never see that key.
4. Record, in the password manager, the upload certificate SHA-256 fingerprint and the app signing certificate fingerprint (Play Console, Test and release, App signing).
5. Complete the store listing and App content pages: copy from `docs/play-store-listing.md`.

---

## Phase 5: smoke tests on the packaged app [CTO]

Run these against the **packaged** Windows build, not the dev server. Replace `$exe` with the real path: `release\win-unpacked\UniView.exe` for the unpacked build, or the installed copy `%LOCALAPPDATA%\Programs\UniView\UniView.exe` (per-user install, `docs/AGENTS.md`).

```powershell
$exe = (Resolve-Path release\win-unpacked\UniView.exe).Path
```

### 5.1 Demo rehearsal

```powershell
node demo\rehearse.mjs $exe
```

It opens six demo files, makes the assistant review and approves it, and saves screenshots to `demo\shots\` (git-ignored). **Pass:** the command exits without an exception, `demo\shots` contains `1-home.png`, `file-*.png`, `3-review.png` and `4-approved.png`, and the last lines print `assistant got exit code 0` and a JSON `"decision":"approved"`. Open `4-approved.png` and look at it. Also run `node demo\verify-cli-open.mjs $exe` (files opened from the command line stay readable after the command exits).

### 5.2 Assistant evals against the packaged exe

`evals\agents.json` and `evals\agents-mcp.json` carry **placeholder** commands (`UniView.exe` and `<install>\resources\uniview-mcp.cmd`), so they must be copied with real paths. This snippet writes the copies to a folder outside the repository and does not touch the originals:

```powershell
$install = Split-Path $exe
$out = 'I:\AES\Data\uniview-release-evals'
New-Item -ItemType Directory -Force $out | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM, so Python can read it

$a = Get-Content evals\agents.json -Raw | ConvertFrom-Json
$a.command = @($exe)
[IO.File]::WriteAllText("$out\agents-packaged.json", ($a | ConvertTo-Json -Depth 20), $utf8)

$m = Get-Content evals\agents-mcp.json -Raw | ConvertFrom-Json
$m.command = @('cmd', '/c', "$install\resources\uniview-mcp.cmd")
[IO.File]::WriteAllText("$out\agents-mcp-packaged.json", ($m | ConvertTo-Json -Depth 20), $utf8)

aes eval --workspace . --suite "$out\agents-packaged.json"     --execute --timeout 120
aes eval --workspace . --suite "$out\agents-mcp-packaged.json" --execute --timeout 120
```

**Pass:** every case passes (`passed` equals `total` in the report `aes eval` writes under `.aes\evals\`). `evals\agents.json` has 6 cases: `open README.md` (cold-starts the app, exit 0) and usage errors (exit 2). `evals\agents-mcp.json` has 3 cases: it drives the bundled MCP launcher through `initialize`, `tools/list` and a rejected `show_view`.

Record on file: `.aes\evals\agents-mcp-packaged-20261025T224734.json` shows 3 of 3 passing for the MCP suite. The only recorded run of the CLI suite (`.aes\evals\agents-packaged-20261025T222715.json`) is 0 of 11, from an older 11-case version of the suite and an older build (timeouts), and no later passing CLI run is on file. **[VERIFY]** that the current `evals\agents.json` passes against the final packaged build; `docs/STATUS.md` says the packaged CLI behaviour was checked after the P27b fix, but no report in `.aes\evals\` proves it.

### 5.3 Cold-start check

The command line must start the app when it is not running and return, without holding the caller's pipes (the bug fixed in P27):

```powershell
Get-Process UniView -ErrorAction SilentlyContinue | Stop-Process -Force
node -e "const {spawnSync}=require('node:child_process');const t=Date.now();const r=spawnSync(process.argv[1],['open','README.md'],{encoding:'utf8',timeout:30000});console.log('exit',r.status,'ms',Date.now()-t,'timedOut',!!(r.error&&r.error.code==='ETIMEDOUT'));console.log((r.stdout||'').trim())" $exe
```

**Pass:** `exit 0`, well under the 15-second start budget in `docs/AGENTS.md`, `timedOut false`, and the output reads `Opened in UniView: ...`. A timeout means a child process is holding the pipe.

### 5.4 Manual checks

- [ ] Right-click the installer, Properties, Digital Signatures: your name and a valid timestamp (if signed).
- [ ] Install `UniView-Setup-<version>.exe` on a clean Windows user (or a VM). Start menu and desktop shortcuts appear. Double-click a PDF, DOCX, XLSX and PPTX from Explorer: each opens as a tab.
- [ ] Run `UniView-Portable-<version>.exe` once; it starts without installing.
- [ ] Offline test: disconnect the network, open the demo files; the Windows firewall asks nothing unless you turn on sharing.
- [ ] Sharing on, pair a real phone, browse a folder, play a video, revoke the device (`demo\DEMO.md`, Part 3). Needs the real phone.
- [ ] Android: install the release build on a phone, use "Open with" from a file manager, share a file to UniView, scan the pairing QR code. Android runtime behaviour has not been verified on a device (`README.md`, Known limits).
- [ ] Uninstall; confirm the folder `%APPDATA%\UniView` is what `docs/PRIVACY.md` says (the privacy policy tells users to delete it by hand). **[VERIFY]**

---

## Phase 6: GitHub repository (Hermes brief, Decision 6) [CEO says go, CTO runs]

**Do not run any of this until the CEO says so.** Nothing has ever been pushed and there are no remotes (`git remote -v` is empty).

1. [CEO] Decide on GitHub Pro (Phase 0.3) and make sure `gh` is signed in.
2. [CTO] From `I:\Development\Clone\Universal\uniview`, run the commands exactly as written in the brief:

   ```bash
   # 1. Authenticate with GitHub CLI (if not already authenticated)
   gh auth login

   # 2. Create the private repository on GitHub (creates remote named 'origin')
   gh repo create uniview --private --source=. --remote=origin --description "Open any file. Offline, private, instant."

   # 3. Push the primary v1 core branch and set upstream tracking
   git push -u origin feat/v1-core

   # 4. Push all remaining feature branches
   git push origin feat/p14b-3 feat/p16-cli feat/p17a-mcp feat/p17b-1

   # 5. Create the production 'main' branch tracking the latest verified core
   git checkout -b main
   git push -u origin main
   git checkout feat/v1-core
   ```

   Notes: the five branch names come from the brief. **[VERIFY]** with `git branch --list` that exactly these exist, and that `feat/v1-core` contains everything you want on `main`. The push uploads **all committed history**; do Phase 1 step 6 first.
3. [CTO] The push triggers `.github/workflows/ci.yml` (branches `main` and `feat/**`, plus pull requests). Open the repository's **Actions** tab and confirm the `verify` job is green. If a job fails only on GitHub, look at the log: typical causes are a missing fixture step or a timing-sensitive Electron test. **[VERIFY]** the first run; the workflow was written and not yet run.
4. [CEO or CTO] If on GitHub Pro: **Settings, Branches, Add branch ruleset** for `main`: require a pull request, require the `CI` workflow check to pass, block force pushes. On Free: the rules above are discipline, not enforcement.
5. [CTO] To get an unsigned installer from GitHub: **Actions, CI, Run workflow**, then download the artifact `uniview-windows-unsigned` (kept 14 days). It is unsigned; real releases are built and signed on your PC (Phase 3).

---

## Phase 7: Play closed test, 12 testers for 14 days

Full plan, templates and opt-in steps: `docs/play-store-listing.md`, section 6. Summary of the order:

1. [CEO] Play Console account verified (Phase 0.2).
2. [CTO] Fill the store listing, content rating and Data safety from `docs/play-store-listing.md`; host `docs/PRIVACY.md` at a public URL and enter it.
3. [CTO] Make the screenshots and the 1024 x 500 feature graphic (the graphic does not exist yet).
4. [CTO] Build and sign `app-release.aab` (Phase 4) and upload it to **Closed testing**.
5. [CEO] Recruit 16 to 20 testers. Send the opt-in link. Keep the opted-in count at 12 or more every day for 14 days.
6. [CTO] Fix what testers report. Each new upload needs a higher `versionCode` (Phase 2).

---

## Phase 8: after Play's 14 days

1. [CEO] On day 15 (or when the console shows 12 testers opted in for 14 continuous days), open Play Console and **apply for production access**. The Hermes brief says to submit the 14-day summary: how you recruited testers, what feedback you received, what you fixed. Keep the notes from Phase 7. **[VERIFY]** the questions the form asks at that time.
2. [CTO] While waiting for Google's answer (it can take days), do not change the package name or signing keys. If you must ship a fix, increase `versionCode`, rebuild, sign, upload to the closed track first.
3. [CEO] When production access is granted: **Production, Create new release**. Either promote the tested build or upload a newer signed `.aab`. Add release notes. Choose countries. Use a **staged rollout** (for example 20 percent) if the console offers it, then raise it to 100 percent after a day or two without crashes. **[VERIFY]**
4. [CTO] Re-check **App content** before submitting: if any code changed since the form was filled (new permission, new network use), update the Data safety answers in `docs/play-store-listing.md` and in the console. A mismatch between the form and the app can get the app removed.
5. [CTO] Watch **Android vitals** (crashes, ANRs) and reviews for the first week. Reply to reviews from `[CONTACT EMAIL]`.
6. [CEO] Windows: publish the **signed** `UniView-Setup-<version>.exe` and portable exe on a download page or a GitHub release, with the SHA-256 of each file and a link to the privacy policy. Warn early users that SmartScreen may still show a warning until reputation builds. **[VERIFY]**
7. [CTO] Record the release in the Obsidian vault (`obsidian-brain` skill): version, date, store links, what is deferred (PowerPoint chart engine for V1.1, Tauri evaluation for V2, iOS streaming, Strix scan).

---

## Quick reference

| Task | Command |
|---|---|
| Full local verification | Phase 1 step 4 |
| Windows installers | `npm run dist:win` (output in `release\`) |
| Android debug APK | `npm run android:apk` (JDK 21) |
| Android release bundle | `npm run cap:sync`, then `cd android; .\gradlew.bat bundleRelease` (JDK 21) |
| Verify Windows signature | `Get-AuthenticodeSignature <file>` |
| Verify Android signature | `jarsigner -verify -verbose -certs <aab>` |
| Packaged smoke tests | `node demo\rehearse.mjs <exe>`, the two `aes eval` suites, the cold-start check |
