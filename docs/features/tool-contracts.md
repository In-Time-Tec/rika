# Tool contracts

Rika exposes exactly four native execution tools beside Generalist's built-in child delegation:

- `bash({ command, workdir?, timeout_ms? })`
- `edit({ path, old_str, new_str, replace_all? })`
- `read({ path, read_range? })`
- `shell_command_status({ processId, waitMillis? })`

Provider-neutral Effect schemas live in `packages/product`; live local and remote behavior lives in `packages/execution`. The schemas bound input and output sizes, produce typed failures, and generate the model-facing surface description so instructions cannot drift from runtime validation.

`bash` runs a recorded command in the shared scoped process registry. A command that outlives its foreground wait returns a process ID. The model must call `shell_command_status` explicitly to observe later output and settlement. `read` returns bounded numbered lines. `edit` requires an exact old string, applies an optional all-occurrences replacement, and returns the authoritative diff.

Read and status calls may be repeated against current state. A timed-out or disconnected `bash` or `edit` can have an unknown outcome and is never replayed blindly. Runner and Orb execution place the native request inside one durable outer operation with stable operation, attempt, tool-call, and machine identities.

## Scoped shell cleanup

On the supported Linux and macOS targets, each command runs below a small `/bin/bash --noprofile --norc --posix` supervisor in its own detached process group. The supervisor reports the command's exit status on a private descriptor and stays alive until cleanup finishes. Neither private descriptor reaches the command. This keeps the process-group identity owned even if the command shell exits before its children. The supervisor does not source Bash startup files, and resets the asynchronous child's SIGINT/SIGQUIT dispositions before `exec`; the requested command retains its arguments, working directory, inherited environment (apart from normal shell bookkeeping such as `SHLVL`), and stdin.

Cancellation, Run scope closure, and normal command completion close the same per-command scope. Effect's released spawner sends group SIGTERM, allows 100 ms for cooperative shutdown, then sends group SIGKILL and waits for the supervisor to exit. Overlapping cleanup callers join completion rather than treating an already-closing scope as finished. No Rika timer signals a saved process-group ID after the supervisor exits. Normal completion retains the actual command's status and drains its output; it also stops leftover same-group background children. Commands intended to keep working must keep their command shell alive (for example, `server & wait`) and use `shell_command_status`.

This costs one supervisor process, two private pipes, and approximately 100 ms of cleanup latency per command, including successful commands. Commands are cleaned up concurrently when the Run scope closes. Cleanup means signals have been delivered to the owned group and its leader has exited; descendant reaping belongs to the OS, so a killed orphan may temporarily remain a zombie.

The registry now reports shell-style statuses: a missing requested executable is 127 rather than a registry `start` failure, and signal termination uses 128 plus the signal number (SIGTERM is 143). Invalid working directories or failure to spawn the supervisor remain typed platform failures. Public `bash` already used shell status 127 for missing commands. A missing or incomplete private status is reported as -1 with truncated output, not success.

In a Linux x64 orb, 20 sequential `/bin/true` executions measured direct-spawner median 1 ms / p95 2 ms versus registry median 106 ms / p95 109 ms. This is a material latency tradeoff, not a performance improvement. Immediate termination only after normal completion is deferred: the released spawner fixes its finalizer's signal policy at acquisition, and adding a second termination path would need additional coordination with cancellation and parent scope closure to preserve group ownership.

This is process-group cleanup, not a containment or security boundary. Descendants that leave the group using `setsid`, `setpgid`, shell job control, or a daemonizing launcher are outside this guarantee; an escaped process retaining stdout/stderr can also prevent output settlement. Arbitrarily killing the supervisor, executor crashes, OS-level uninterruptible waits, descendants that change signal permissions, and hostile processes are not covered by graceful scoped cleanup. Windows is not supported by this supervisor or the current native release targets. Linux process regressions cover the contract; macOS uses the same POSIX primitives but requires macOS acceptance before claiming platform verification.
