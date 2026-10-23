TYPE 1

While the React viewer core isolates UI logic behind a `FileSource` interface, swapping the application shell across four target platforms (Windows, macOS, Android, iOS) cannot be reversed within 15 minutes. 

The shell dictates foundational toolchains (Rust/Cargo vs. Node/Capacitor), divergent IPC security models, native OS file associations, mobile project scaffolding, and CI/CD release pipelines. Reversing this choice later requires rewriting native integration harnesses, reconfiguring platform permissions, and replacing packaging infrastructure across desktop and mobile targets. Because unwinding these platform-level dependencies demands significant engineering hours rather than a trivial rollback, this is a Type 1 decision.
