The strongest case for B is avoiding disposable shell work: installing Rust and MSVC is a bounded cost, while C adds two production adapters and a third experimental adapter. Toolchain readiness alone is too weak a reason for a TYPE 1 choice.

However, one Tauri framework does not eliminate platform-specific file permissions, lifecycle handling, URI semantics or WebView differences. Its smaller binaries and faster cold start also do not establish faster first viewing or equivalent format coverage. C lets those outcomes decide while progressing toward V1.

I recommend C, with three corrections:

- **Treat signing as the latest gate, not the beginning of lock-in.** Platform integrations, packaging and accumulated shell assumptions can make switching costly earlier. Schedule the prototype before substantial shell-specific investment.
- **Make the benchmark decisive.** Use the same 500 files to measure cold time-to-first-view, rendering correctness, format coverage and adapter complexity on representative platforms. Set absolute V1 targets and migration criteria beforehand. Installer size alone should not justify switching.
- **Validate Apple feasibility early.** Gander establishes an Android pattern, not Capacitor integration or Apple compatibility. Obtain CI builds and representative runtime evidence early; builds alone cannot validate viewing behavior.

A strict interface reduces migration scope; it cannot guarantee shell independence or eliminate WebView incompatibilities. Enforce the boundary through import checks, and reserve time both for the prototype and any resulting migration. Do not cancel it solely because Electron meets its startup target.

**APPROVE — Option C with a funded, enforced decision gate.**
