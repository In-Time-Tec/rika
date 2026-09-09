# Native process lifecycle

The native process registry owns finite shell commands, including commands whose initial wait returns before completion. Returning a background process ID does not create a service lease. There is no native lease renewal or detached-service API; a long-running command remains owned by its registry scope.

## Cancellation and ownership

On the supported Linux and macOS targets, each command starts in a new detached POSIX process group. A private shell supervisor stays alive after the command shell exits, so the group leader remains owned through cleanup. The released Effect process spawner sends SIGTERM to that group, waits up to 100 milliseconds, then sends SIGKILL if the supervisor remains alive. Descendants and grandchildren that remain in the group receive those signals, even if the command shell exits before them. Normal command completion also closes the group: launching a server with shell `&` is not a way to acquire an independent service lease.

Concurrent cancellations join the same cleanup. Repeating cancellation for a retained entry is a no-op after cleanup, and cancellation does not discard unread output or the terminal receipt. Unknown or evicted IDs return `ProcessNotFound`; IDs are never interpreted as operating-system PIDs.

This is process-group ownership, not a security sandbox. A program that deliberately calls `setsid` or changes its process group can escape it. The registry does not scan the host and signal guessed descendant PIDs. If the supervisor is externally killed, group ownership can no longer be relied on; the registry does not claim that surviving descendants were terminated. After the supervisor exits, a missing status channel and output streams that remain open are bounded independently by 100-millisecond waits. Missing command status is reported as exit code `-1` with truncated output, not successful completion or an indefinitely running process.

## Observation, output, and shutdown

Stopping an observer does not cancel the command. Explicit cancellation, normal command completion, and closing the owning registry scope perform cleanup. Graceful Runner teardown must close that scope. Abrupt host or Runner death cannot run Effect finalizers and does not promise the same graceful cleanup.

Scope shutdown invalidates the registry's retained entries and releases pending observers with `ProcessNotFound` when no terminal receipt was obtained. A closed registry rejects new starts. Opaque process IDs include a random registry incarnation as well as a local counter, so an old ID cannot address the replacement registry's first command. No process is reconstructed from a stored OS PID after restart.

Each process retains at most 64 KiB of unread stdout and stderr combined while continuing to drain both streams. Polling applies the caller's output limit. Terminal results already returned by polling are retained for at most 128 processes; eviction makes those IDs unavailable. Output truncation is explicit.

## Integration gate

This is native-handler preparation for Rika #384, not completion of the Generalist Tool Run integration. Rika #380 must connect released Tool Run cancellation and observation to this ownership boundary, distinguish finite commands from any explicitly defined service leases, and verify the complete Runner flow before #384 can close. Observer disconnect and actor sleep must not be mapped to native cancellation. No unreleased Generalist schema or new scheduler is defined here.

The focused process suite exercises real processes, group descendants and grandchildren, TERM resistance, concurrent and repeated cancellation, unrelated group isolation, observer interruption, bounded output, shutdown, and unexpected supervisor loss. The native handler was qualified on Linux x64 and macOS arm64 with Bun 1.4.0: all 18 process tests and 13 registry unit tests passed on both platforms. macOS uses its system Zsh as supervisor. These checks qualify the local native handler, not the pending #380 Tool Run integration.
