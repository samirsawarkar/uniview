TYPE 1

The shell is swappable, but replacing it across four platforms is unlikely to take about 15 minutes. A small FileSource interface protects the shared viewer core; it does not eliminate migration work for native file access, permissions, packaging, signing, updates, platform configuration, and testing.

Installing Rust and MSVC is a setup cost, not the main source of irreversibility. The larger commitment is the platform integration and release infrastructure built around the chosen shell.

I would choose A to start because it is buildable with the installed toolchain, while preserving the shell boundary. That makes a later migration more manageable, but does not make this a TYPE 2 decision.
