# GitHub Issue Inventory

Starting snapshot: 2026-07-14

## Counts

| Repository | Open at start | New during autoresearch |
| --- | ---: | ---: |
| `dallenpyrah/rika` | 0 | 1 |
| `In-Time-Tec/batonfx` | 2 | 0 |
| `In-Time-Tec/relayfx` | 6 | 0 |

## Queue

| Issue | Starting state | Owner | Rika relationship | Status |
| --- | --- | --- | --- | --- |
| [Rika #117](https://github.com/dallenpyrah/rika/issues/117) Idle packaged TUI continuously consumes CPU in both client and resident | New | Rika, exact subsystem under investigation | Direct packaged-product failure, reproduced twice | Diagnosing |
| [Baton #36](https://github.com/In-Time-Tec/batonfx/issues/36) Support reasoning parts in TestModel scripted responses | Open | Baton test package | Rika deterministic reasoning evidence | Queued |
| [Baton #35](https://github.com/In-Time-Tec/batonfx/issues/35) Add typed OAuth lifecycle support to MCP remote transports | Open | Baton MCP | Rika currently owns host OAuth behavior around Baton MCP | Queued |
| [Relay #180](https://github.com/In-Time-Tec/relayfx/issues/180) Inbox delivery racing a parking wait kills the execution | Open | Relay inbox/event allocation | Rika Thread Host previously needed a sequencing guard | Queued |
| [Relay #129](https://github.com/In-Time-Tec/relayfx/issues/129) Embedded runtime hides required Crypto layer | Open | Relay runtime composition | Rika clean consumer can fail during agent registration | Queued |
| [Relay #126](https://github.com/In-Time-Tec/relayfx/issues/126) Apply accepted steering to the next Baton model request | Open | Relay agent execution | Rika steering contract | Queued |
| [Relay #123](https://github.com/In-Time-Tec/relayfx/issues/123) Expose durable Baton compaction checkpoints | Open | Relay durable agent execution | Rika restart-safe compaction | Queued |
| [Relay #121](https://github.com/In-Time-Tec/relayfx/issues/121) Interrupt in-flight Baton work on cancellation | Open | Relay cancellation | Rika active Turn cancellation | Queued |
| [Relay #55](https://github.com/In-Time-Tec/relayfx/issues/55) Prove restart durability across server and runners | Open | Relay E2E | Framework durability used by Rika | Queued |

## Issue update policy

The coordinator will update ownership and acceptance criteria from Rika evidence. A fixer closes an issue only after owner-repository verification and packaged Rika verification when Rika is affected.
