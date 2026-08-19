# Context resolution

Before execution, Rika resolves Workspace guidance, explicit file and guidance mentions, Thread references, and images into ordered model context. Guidance is selected from the Workspace root through mentioned paths, preferring `AGENTS.md`, then `AGENT.md`, then `CLAUDE.md` in each directory.

Explicit mentions may resolve anywhere the user running Rika can read and are shown by absolute path when they fall outside the Workspace; automatic guidance discovery stays inside the Workspace, so an outside file is never trusted as instructions. Resolution sorts and deduplicates sources and records content digests. Guidance files supply instructions; mentioned files, Thread content, and other untrusted sources remain data. Missing, unreadable, or unmatched references produce diagnostics instead of silently supplying content; glob discovery is bounded to one thousand files and thirty-two directory levels.
