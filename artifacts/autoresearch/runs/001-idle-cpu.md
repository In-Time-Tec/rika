# Run 001: Packaged TUI Idle CPU

Date: 2026-07-14

Status: failed

Issue: [Rika #117](https://github.com/dallenpyrah/rika/issues/117)

## Workload

- Extract packaged `rika-darwin-arm64.tar.gz` with SHA-256 `ef1c659660e0a212f9d88c58e3b5fc3ab68c012404ce3a074eb8663061dff412`.
- Use fresh isolated `HOME`, product database, Relay database, diagnostics directory, and Workspace.
- Spawn in Pilotty at `80x24` with `TERM=xterm-256color` and `COLORTERM=truecolor`.
- Wait for the welcome screen without blind sleeps.
- Read safe client and resident PIDs from `process.started` diagnostics events.
- Record process CPU, RSS, PTY output volume, and a five-second macOS sample.
- Repeat in a second fresh data root.
- In the second run, submit one deterministic Turn, wait for `AUTORESEARCH-COMPLETE`, then measure terminal output and process CPU while idle.

## Results

| Check | Client | Resident | Result |
| --- | ---: | ---: | --- |
| Run 1 idle after about one minute | 39.6% CPU, 224 MB RSS | 39.9% CPU, 129 MB RSS | Failed |
| Run 2 idle after about 50 seconds | 52.9% CPU, 216 MB RSS | 47.0% CPU, 176 MB RSS | Failed |
| Run 2 terminal idle CPU time over 10 seconds | `0:48.09` to `0:52.92` | `0:47.02` to `0:51.80` | Failed |

Run 2 reached the deterministic visible result in 860 ms after input dispatch. During a later 15-second terminal-idle window, Pilotty's retained byte count stayed exactly `786046`, so the screen was static while both processes continued consuming about half a CPU core.

The first run emitted about 745 KB while the welcome animation was active and 1.4 MB over its two-minute lifetime. That animation output is a separate load contributor but does not explain the static-screen CPU use.

## Diagnostics

Both runs recorded ordinary process start, resident spawn/connect, Interactive initialization, and action completion. No repeated operation, failure, reconnect, or event stream was logged during the idle interval. The available logs prove the process boundary but cannot attribute active runtime work.

## Conclusion

Fact: sustained CPU use occurs in both packaged processes and persists when the terminal emits no bytes.

Conclusion: at least one non-rendering hot loop exists in the client and resident runtime paths. The similar process load is not enough to conclude that one shared framework implementation is responsible.

Still assumed: the source build reproduces the packaged behavior and can provide enough symbols or instrumentation to separate Effect scheduling, WebSocket transport, Relay hosting, and OpenTUI activity.

## Next experiment

Run equivalent source-hosted client and resident paths separately, profile with symbols, and measure CPU-time deltas while selectively removing only one active resource at a time. Do not change behavior until the first hot boundary is proved.
