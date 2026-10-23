Classification: TYPE 1

Vote Count:
TYPE 1: 3
TYPE 2: 0 (Unanimous TYPE 1)

Strongest Reason for TYPE 1:
While the FileSource interface isolates the UI core, replacing the shell across four platforms (Windows, macOS, Android, iOS) requires rebuilding native packaging, signing/notarization pipelines, OS-level integrations (file associations, intent handlers, security-scoped bookmarks/content URIs), and auto-updater infrastructure. Reversing this choice later demands days to weeks of engineering rather than a trivial rollback, and becomes significantly harder once store listings, updater channels, and app identities are shipped to users.
