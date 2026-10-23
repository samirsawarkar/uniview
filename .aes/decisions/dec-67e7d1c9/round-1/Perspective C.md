TYPE 1

By the 15-minute test this is TYPE 1, even if only mildly. The FileSource seam keeps the viewer core portable, but the shell is more than file access. Changing it later means redoing:

- **Packaging and signing:** MSIX/NSIS, macOS notarization, Android and iOS signing.
- **Native glue:** auto-update, file associations and "open with" intents, store listings.
- **Platform plugins:** content-URI and security-scoped bookmark handling, written against Capacitor or Tauri plugin APIs.

That's days of work per platform, not minutes. Once you ship, it gets worse: installed users have to migrate updater channels and the app's identity, and the bundle IDs and signing keys in store listings are hard to change.

There's a mitigation. Before the first public release, a switch costs about a week of engineering and nothing more. So pick A now to get moving, keep the FileSource boundary strict, and treat the first store or installer release as the real point of no return.
