# Rika Feature Inventory

This is the canonical product feature ledger. It distinguishes Amp behavior, Rika v1 behavior, Rika v2 intent, implementation status, owning specification, and proof.

Status values:

- `planned`: included but not implemented.
- `framework-blocked`: included but awaiting a published Baton or Relay capability.
- `implementing`: active implementation exists but is not fully verified.
- `implemented`: code exists and local tests pass.
- `verified`: the real packaged flow and parity evidence pass.
- `excluded`: deliberately outside Rika v2.
- `deferred`: not required for initial completion but compatible with the architecture.

## Modes and Models

| Feature                         | Amp July 2026         | Rika v1               | Rika v2                            | Status      | Spec   | Evidence                                                    |
| ------------------------------- | --------------------- | --------------------- | ---------------------------------- | ----------- | ------ | ----------------------------------------------------------- |
| `low` mode                      | Yes                   | Yes                   | Luna low; Oracle Sol high          | implemented | 04     | Config contract and runtime routing tests                   |
| `medium` mode                   | Yes                   | Yes                   | Terra medium; Oracle Sol high      | implemented | 04     | Config contract and runtime routing tests                   |
| `high` mode                     | Yes                   | Yes                   | Sol xhigh; Oracle Sol max          | implemented | 04     | Config contract and runtime routing tests                   |
| `ultra` mode                    | Yes                   | Yes                   | Sol max; Oracle Sol max            | implemented | 04     | Config contract and runtime routing tests                   |
| Specialist model routes         | Fixed built-ins       | No                    | Configurable GPT routes            | implemented | 04, 07 | Config merge, route-pin, preset, fan-out, and restart tests |
| Stable mode dial                | `Ctrl+S`              | Implemented           | Included                           | verified    | 04, 11 | Pure reducer, native renderer, and packaged PTY tests       |
| Mode-specific tools/policy      | Yes                   | Partial               | Included                           | planned     | 04, 06 | Pending                                                     |
| Mode-specific Oracle            | Yes                   | Implemented           | Included                           | implemented | 04, 07 | Root, preset, and fan-out selection tests                   |
| Raw model picker                | Plugin/custom surface | No default            | Not a default surface              | excluded    | 04     | Decision 0008                                               |
| Legacy `rush/smart/deep*` modes | Deprecated            | Compatibility existed | Omitted                            | excluded    | 04     | Decision 0008                                               |
| Separate reasoning-effort dial  | Transitional          | Partial               | Mode-owned only                    | excluded    | 04     | Decision 0008                                               |
| Fast speed toggle               | Model-dependent       | Implemented           | Included when provider supports it | planned     | 04, 11 | Pending                                                     |

## Prompt and Input

| Feature                     | Amp July 2026               | Rika v1 | Rika v2                                  | Status            | Spec       | Evidence                                                                           |
| --------------------------- | --------------------------- | ------- | ---------------------------------------- | ----------------- | ---------- | ---------------------------------------------------------------------------------- |
| Enter submit                | Yes                         | Yes     | Included                                 | implemented       | 11         | TUI adapter and view-state tests                                                   |
| Shift+Enter newline         | Yes                         | Yes     | Included                                 | planned           | 11         | Pending                                                                            |
| Ctrl+J newline              | Yes                         | Yes     | Included                                 | planned           | 11         | Pending                                                                            |
| Backslash+Enter newline     | Yes                         | Yes     | Included                                 | planned           | 11         | Pending                                                                            |
| Auto-growing input          | Yes                         | Yes     | Included                                 | verified          | 11         | Pure sizing, native OpenTUI drag routing, and live agent-tty resize snapshot       |
| Prompt history              | `Ctrl+R`                    | Yes     | Included                                 | verified          | 11         | Structured draft restore and multiline-boundary reducer tests                      |
| External editor             | `Ctrl+G` and activity paths | Yes     | Included                                 | implemented       | 11         | Composer and workspace-safe path launch suspend and restore the terminal           |
| File mention                | `@`                         | Yes     | Included                                 | verified          | 09, 11     | Completion reducer, native renderer, packaged PTY, and Resolved Context tests      |
| Thread mention              | `@@`                        | Yes     | Amp-style browser and `@<id>` insertion  | verified          | 05, 09, 11 | Packaged Pilotty picker/insertion capture and Resolved Context tests               |
| Clipboard image paste       | Yes                         | Yes     | Included                                 | implemented       | 09, 11     | Ctrl+V extraction, typed terminal-paste bytes, and TUI tests                       |
| Collapsed pasted text       | Yes                         | Yes     | Included                                 | verified          | 11         | View-state, native adapter, text-only model-input boundary, and packaged PTY tests |
| Dropped/image path input    | Yes                         | Yes     | Included                                 | implemented       | 09, 11     | Ordered parts, durable replay, model request tests                                 |
| Queue messages while busy   | Yes                         | Yes     | Included                                 | implemented       | 08, 11     | Memory/SQLite repository and Run promotion tests                                   |
| Enter-Enter steering        | Yes                         | Yes     | Included                                 | implemented       | 08         | Native Baton request capture through Relay                                         |
| Esc-Esc interrupt/send      | Yes                         | Yes     | Included                                 | framework-blocked | 08         | Relay public API proof                                                             |
| Edit queued messages        | Yes                         | Yes     | Included                                 | implemented       | 08, 11     | Durable TurnRepository queue projection and service tests                          |
| Dequeue messages            | Yes                         | Yes     | Included                                 | implemented       | 08, 11     | ID-selected joined queue panel and service tests                                   |
| Edit prior message          | Yes                         | Yes     | Included                                 | planned           | 05, 11     | Pending                                                                            |
| Restore prior state         | Historical/current partial  | Yes     | Included if durable semantics are proven | planned           | 05         | Pending                                                                            |
| Fork from prior turn        | Yes                         | Yes     | Included                                 | implemented       | 05         | Bounded-history fork operation and command tests                                   |
| Shell prompt prefix `$`     | Yes                         | Yes     | Included                                 | implemented       | 06, 11     | Operation + native OpenTUI + product SQLite test                                   |
| Incognito shell prefix `$$` | Yes                         | Yes     | Included                                 | implemented       | 06, 11     | Operation + native OpenTUI + product SQLite test                                   |

## TUI and Navigation

| Feature                          | Amp July 2026     | Rika v1          | Rika v2                           | Status       | Spec   | Evidence                                                                                                                                    |
| -------------------------------- | ----------------- | ---------------- | --------------------------------- | ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-screen OpenTUI              | Proprietary TUI   | OpenTUI          | Included                          | implementing | 11     | Packaged native PTY proves rendering, keyboard submission, resize, SIGINT, and termios restoration; incremental streaming remains pending   |
| Rika welcome screen              | N/A               | Yes              | Pixel baseline                    | implemented  | 11     | Frozen native character-frame and screenshot baseline                                                                                       |
| Flat transcript                  | Yes               | Yes              | Included                          | implemented  | 11     | TUI adapter tests prove cursor replay does not duplicate terminal entries                                                                   |
| Bounded transcript history       | Yes               | Yes              | Included                          | implementing | 05, 11 | Semantic-unit SQLite pages, acknowledged resident delivery, and a movable 200-entry native render window                                    |
| User colored left border         | Yes               | Yes              | Included                          | planned      | 11     | Pending                                                                                                                                     |
| Assistant Markdown               | Yes               | Yes              | Included                          | planned      | 11     | Pending                                                                                                                                     |
| Reasoning display                | Yes               | Yes              | Included                          | implemented  | 11     | Deterministic reasoning projection and replay harness                                                                                       |
| File tree sidebar                | `Alt+T`           | Yes              | Included                          | verified     | 11     | 10,000-file native latency test plus installed Pilotty and agent-tty post-Turn input checks                                                 |
| Semantic tool cards              | Yes               | Yes              | Included                          | implemented  | 11     | Frozen native tool-card character-frame and screenshot baseline                                                                             |
| Syntax-aware diffs               | Yes               | Yes              | Included                          | implemented  | 11     | Frozen native diff character-frame and screenshot baseline                                                                                  |
| Clickable file paths/ranges      | Yes               | Yes              | Included                          | implemented  | 11     | Native path children invoke workspace-validated VISUAL/EDITOR targets                                                                       |
| Command palette                  | `Ctrl+O`          | Yes              | Thread, mode, fast, and quit only | implemented  | 11, 13 | Exact command contract, reducer, native renderer, and packaged exit tests                                                                   |
| Thread sidebar                   | `Ctrl+\`          | Partial          | Amp-style left pane               | verified     | 05, 11 | Packaged Pilotty keyboard/mouse captures and matched agent-tty PNG evidence                                                                 |
| Changed-files sidebar            | Yes               | Partial          | Included                          | verified     | 11     | Virtual row window, 10,000-file native latency test, installed Pilotty and agent-tty post-Turn checks, PNG, scrolling, clicking, and resize |
| Multiple background threads      | Yes               | Partial          | Durable live summaries            | verified     | 05, 07 | Live waiting/queue Pilotty capture, edit-total execution, SQL reopen, restart repair, and watcher tests                                     |
| Sidebar keyboard navigation      | Yes               | Partial          | Included                          | verified     | 11     | Packaged Pilotty keyboard and mouse selection captures                                                                                      |
| Response outline                 | Yes               | No               | Included                          | planned      | 11     | Pending                                                                                                                                     |
| Context analysis view            | Yes               | Partial          | Included                          | planned      | 09, 11 | Pending                                                                                                                                     |
| Cost display                     | Yes               | Partial          | Included                          | implemented  | 11, 16 | Typed context/cost transcript block and adapter tests                                                                                       |
| Notifications                    | Yes               | Partial          | Included                          | implemented  | 11, 16 | Typed notification transcript block and adapter tests                                                                                       |
| Terminal background inheritance  | Yes               | Yes              | Included                          | planned      | 11     | Pending                                                                                                                                     |
| Narrow-terminal layout           | Yes               | Yes              | Included                          | implemented  | 11     | Frozen native narrow-layout character-frame and screenshot baseline                                                                         |
| Scroll stability while streaming | Yes               | Yes              | Included                          | implemented  | 11, 15 | Reducer intent plus measured native adapter attach, detach, anchor, resize, and bottom-follow coverage                                      |
| Auto-follow recovery             | Yes               | Yes/partial      | Included                          | planned      | 11, 15 | Pending                                                                                                                                     |
| Bounded long-thread rendering    | Yes               | Partial          | Included                          | planned      | 11, 15 | Pending                                                                                                                                     |
| Startup latency budget           | Yes               | Documented in v1 | Included                          | planned      | 03, 15 | Pending                                                                                                                                     |
| Input latency budget             | Yes               | Documented in v1 | Included                          | planned      | 03, 15 | Pending                                                                                                                                     |
| Child-run activity               | Yes               | Partial          | Included                          | implemented  | 07, 11 | Frozen activity frame plus Relay SQLite child-run restart harness                                                                           |
| Workflow activity                | Product extension | No               | Included                          | implemented  | 14, 11 | Frozen activity frame plus delivery/research workflow restart harness                                                                       |

## Threads

| Feature                         | Amp July 2026    | Rika v1                    | Rika v2                              | Status       | Spec   | Evidence                                         |
| ------------------------------- | ---------------- | -------------------------- | ------------------------------------ | ------------ | ------ | ------------------------------------------------ |
| Create thread                   | Yes              | Yes                        | Included                             | verified     | 05     | Packaged lifecycle E2E                           |
| Continue last thread            | Yes              | Yes                        | Included                             | implemented  | 05, 13 | Parser and interactive startup selection tests   |
| Continue by ID                  | Yes              | Yes                        | Included                             | implemented  | 05, 13 | Parser and interactive startup selection tests   |
| Continue multiple threads       | Yes              | No                         | Included                             | planned      | 05, 13 | Pending                                          |
| List threads                    | Yes              | Yes                        | Included                             | verified     | 05, 13 | Packaged lifecycle E2E                           |
| Search by text                  | Yes              | Yes                        | Included                             | verified     | 05, 13 | Packaged lifecycle E2E                           |
| Search by file/repo/ref         | Yes              | Partial                    | Included                             | planned      | 05, 13 | Pending                                          |
| Rename thread                   | Yes              | No/partial                 | Included                             | verified     | 05     | Packaged lifecycle E2E                           |
| Label thread                    | Yes              | Partial                    | Included                             | verified     | 05     | Packaged lifecycle E2E                           |
| Pin thread                      | Yes              | No/partial                 | Included                             | verified     | 05, 11 | Packaged lifecycle E2E                           |
| Archive/unarchive               | Yes              | Yes                        | Included                             | verified     | 05     | Packaged lifecycle E2E                           |
| Delete thread                   | Yes              | Yes                        | Included                             | implementing | 05     | Metadata deletion E2E; Relay retention pending   |
| Fork thread                     | Yes              | Yes                        | Included                             | implemented  | 05     | Thread command and operation tests               |
| Markdown export                 | Yes              | Partial                    | Included                             | implemented  | 05, 13 | Thread command and operation tests               |
| JSON export                     | Yes              | Import-oriented            | Included                             | implemented  | 05, 13 | Thread command and operation tests               |
| Usage/cost query                | Yes              | Partial                    | Included                             | implemented  | 05, 16 | Thread command and operation tests               |
| Automatic compaction            | Yes              | Manual+automatic internals | Included                             | implemented  | 09     | Baton strategy and Relay checkpoint replay tests |
| Automatic thread titling        | Yes              | Yes                        | Included                             | planned      | 04, 05 | Pending                                          |
| Dedicated media route           | Yes              | Yes                        | Included                             | planned      | 04, 06 | Pending                                          |
| Dedicated Painter route         | Yes              | Yes                        | Included                             | planned      | 04, 06 | Pending                                          |
| Dedicated compaction route      | Yes              | Yes                        | Included                             | implemented  | 04, 09 | Config, immutable route pin, Relay policy tests  |
| Manual compact command          | Removed from Amp | Yes                        | Diagnostic-only if retained          | deferred     | 09     | Pending                                          |
| Private local thread state      | Yes              | Yes                        | Included                             | planned      | 05     | Pending                                          |
| Hosted visibility/share URLs    | Yes              | Yes/local approximation    | Omitted                              | excluded     | 01     | Decision 0001                                    |
| Support report upload           | Yes              | Local doctor only          | Omitted; local report export instead | excluded     | 16     | Decision 0001                                    |
| Remote control/web continuation | Yes              | Removed from local v1      | Omitted                              | excluded     | 01     | Decision 0001                                    |

## Context

| Feature                         | Amp July 2026              | Rika v1         | Rika v2  | Status      | Spec   | Evidence                                                          |
| ------------------------------- | -------------------------- | --------------- | -------- | ----------- | ------ | ----------------------------------------------------------------- |
| Parent `AGENTS.md` discovery    | Yes                        | Yes             | Included | implemented | 09     | Resolved-context tests                                            |
| Subtree guidance discovery      | Yes                        | Yes             | Included | implemented | 09     | Resolved-context tests                                            |
| Global guidance                 | Yes                        | Yes             | Included | implemented | 09     | Resolved-context tests                                            |
| `AGENT.md` fallback             | Yes                        | Partial         | Included | implemented | 09     | Resolved-context tests                                            |
| `CLAUDE.md` fallback            | Yes                        | Yes             | Included | implemented | 09     | Resolved-context tests                                            |
| Guidance file references        | Yes                        | Yes             | Included | implemented | 09     | Resolved-context reference selection and diagnostics tests        |
| Guidance globs                  | Yes                        | Yes             | Included | implemented | 09     | Workspace-bounded deterministic glob resolution tests             |
| Deterministic resolved context  | Observable behavior        | Yes             | Included | implemented | 09     | Resolved-context tests                                            |
| Thread references               | Yes                        | Yes             | Included | implemented | 05, 09 | Typed mention parsing and existing/missing Thread expansion tests |
| Image context                   | Yes                        | Yes             | Included | implemented | 09     | Typed image mentions and ordered durable model-request tests      |
| IDE open-file/selection context | Yes                        | Broader v1 only | Omitted  | excluded    | 01     | Decision 0001                                                     |
| Automatic repeated compaction   | Yes                        | Partial         | Included | planned     | 09     | Pending                                                           |
| Compacted-history search        | Yes                        | Partial         | Included | planned     | 05, 09 | Pending                                                           |
| Semantic code search            | Not required core behavior | Yes             | Omitted  | excluded    | 06     | Decision 0009; archive, TUI, and visual-frame absence checks      |
| Ast-grep outline                | Rika addition              | Yes             | Omitted  | excluded    | 06     | Decision 0009; archive, TUI, and visual-frame absence checks      |

## Built-In Tools

Catalog completeness is enforced by `bun run catalog:evidence`: all 18 entries in `Catalog.definitions` map to either the 29-test standard durable transcript matrix or the 3-test specialty transcript matrix. Both matrices also assert completeness for their respective catalog partitions.

| Tool/Feature                | Amp July 2026              | Rika v1             | Rika v2  | Status      | Spec   | Evidence                                                   |
| --------------------------- | -------------------------- | ------------------- | -------- | ----------- | ------ | ---------------------------------------------------------- |
| File finder                 | Yes                        | fff                 | Included | implemented | 06     | Standard deterministic transcript matrix                   |
| Grep/content search         | Yes                        | fff/grep            | Included | implemented | 06     | Standard deterministic transcript matrix                   |
| Read file                   | Yes                        | Hashline read       | Included | implemented | 06     | Standard deterministic transcript matrix                   |
| Create file                 | Yes                        | Yes                 | Included | implemented | 06     | Native runtime and toolkit routing tests                   |
| Edit file                   | Yes                        | Hashline edit       | Included | implemented | 06     | Native runtime and toolkit routing tests                   |
| Apply patch                 | Yes                        | Yes                 | Included | implemented | 06     | Native runtime and toolkit routing tests                   |
| Hashline anchored reads     | No exact public equivalent | Yes                 | Included | planned     | 06     | Pending                                                    |
| Stale-anchor edit rejection | No exact public equivalent | Yes                 | Included | implemented | 06     | Native tool runtime test                                   |
| Shell command               | Yes                        | Yes                 | Included | implemented | 06     | Native runtime and toolkit routing tests                   |
| Shell status                | Yes                        | Yes                 | Included | implemented | 06     | Native runtime and tool contract tests                     |
| Git inspection              | Through shell/tools        | Yes                 | Included | implemented | 06     | Native runtime and toolkit routing tests                   |
| View media                  | Yes                        | Yes                 | Included | implemented | 06     | Native image/document routing and analyzer tests           |
| Web search                  | Yes                        | Specialty tool      | Included | implemented | 06     | Parallel adapter, HTTP contract, and toolkit routing tests |
| Read web page               | Yes                        | Specialty tool      | Included | implemented | 06     | Parallel Extract HTTP contract and toolkit tests           |
| Find thread                 | Yes                        | Yes                 | Included | implemented | 05, 06 | Thread query and tool-handler tests                        |
| Read thread                 | Yes                        | Named subagent/tool | Included | implemented | 05, 06 | Thread query and tool-handler tests                        |
| Task/subagent               | Yes                        | Yes                 | Included | implemented | 07     | Specialty deterministic transcript matrix                  |
| Oracle                      | Yes                        | Yes                 | Included | implemented | 07     | Specialty deterministic transcript matrix                  |
| Librarian                   | Yes                        | Yes                 | Included | implemented | 07     | Specialty deterministic transcript matrix                  |
| Painter                     | Yes                        | Yes                 | Included | implemented | 06, 07 | Specialty deterministic transcript matrix                  |
| Skill activation            | Yes                        | Yes                 | Included | implemented | 09     | Skill registry discovery and activation tests              |
| MCP resources               | Yes                        | Yes                 | Included | implemented | 10     | Activated skill-resource MCP composition test              |
| Tool list/show CLI          | Yes                        | Partial             | Included | implemented | 06, 13 | Product operation tests                                    |

## Multi-Agent and Review

| Feature                     | Amp July 2026                  | Rika v1    | Rika v2               | Status            | Spec       | Evidence                                                                                 |
| --------------------------- | ------------------------------ | ---------- | --------------------- | ----------------- | ---------- | ---------------------------------------------------------------------------------------- |
| Isolated child context      | Yes                            | Yes        | Included              | framework-blocked | 07         | Relay proof                                                                              |
| Narrow child tools          | Yes                            | Yes        | Included              | framework-blocked | 07         | Relay proof                                                                              |
| Narrow child model limits   | Yes                            | Yes        | Included              | implemented       | 04, 07     | Provider-limit specialist route pin and Relay preset/fan-out tests                       |
| Parallel child runs         | Yes                            | Up to four | Included              | implemented       | 07         | Product-agent bounded fan-out test                                                       |
| Automatic subagent spawning | Yes                            | Partial    | Included              | implemented       | 07         | Product-agent profile-selection test                                                     |
| Model-driven subagent tools | Yes                            | No         | Included              | implemented       | 07         | Native turn drives `transfer_to_oracle`, durable child spawn, and parent resume          |
| Child final-summary return  | Yes                            | Yes        | Included              | framework-blocked | 07         | Relay proof                                                                              |
| Durable child execution     | Hosted behavior                | No         | Included              | implemented       | 07         | Rika ProductAgent SIGKILL/restart harness over public Relay SQLite host                  |
| Durable parent-child join   | Hosted behavior                | No         | Included              | implemented       | 07         | Rika harness proves all, first-success, quorum, and best-effort joins with parent resume |
| Review command              | Yes                            | Yes        | Included              | verified          | 06, 07, 13 | Extracted packaged artifact runs durable review lanes with stable text output            |
| Parallel review checks      | Yes                            | Yes        | Included              | implemented       | 07         | Product-agent Review-lane contract                                                       |
| Review JSON output          | Yes                            | Partial    | Included              | verified          | 13         | Extracted packaged artifact returns completed lane ids, outputs, and satisfied status    |
| Built-in durable workflows  | Custom agents/plugins evolving | No         | Delivery and research | implemented       | 14         | `rika workflows start/inspect`; Relay restart and pinned-definition tests                |
| Generic workflow primitives | Custom agents/plugins evolving | No         | Not claimed           | framework-blocked | 14         | No generic authoring surface; approval and branch semantics are not product-proven       |

## Skills, MCP, and Plugins

| Feature                 | Amp July 2026                      | Rika v1 | Rika v2                                 | Status      | Spec   | Evidence                                                            |
| ----------------------- | ---------------------------------- | ------- | --------------------------------------- | ----------- | ------ | ------------------------------------------------------------------- |
| File-based skills       | Yes                                | Yes     | Included                                | implemented | 09     | Skill registry native tests                                         |
| Lazy skill activation   | Yes                                | Yes     | Included                                | implemented | 09     | Skill registry native tests                                         |
| Skill scripts/templates | Yes                                | Yes     | Included                                | planned     | 09     | Pending                                                             |
| Skill-bundled MCP       | Yes                                | Partial | Included                                | implemented | 09, 10 | Activated-resource MCP composition test                             |
| Skill list/inspect      | Yes                                | Yes     | Included                                | verified    | 09, 13 | Extracted packaged artifact lists and inspects an added skill       |
| Skill add/remove CLI    | Current binary, unstable direction | Yes     | Included for local file management      | verified    | 09, 13 | Extracted packaged artifact adds and removes a fixture skill        |
| Local command MCP       | Yes                                | Yes     | Included                                | implemented | 10     | MCP config/runtime tests                                            |
| Remote MCP              | Yes                                | Yes     | Included                                | implemented | 10     | MCP config/runtime tests                                            |
| MCP headers/environment | Yes                                | Yes     | Included                                | implemented | 10     | MCP config/runtime tests                                            |
| MCP OAuth               | Yes                                | Yes     | Baton protocol with Rika browser/store  | implemented | 10     | Deterministic service and packaged command coverage                 |
| Workspace MCP approval  | Yes                                | Yes     | Included                                | implemented | 10     | MCP trust persistence tests                                         |
| MCP doctor              | Yes                                | Yes     | Included                                | verified    | 10, 13 | Extracted packaged artifact runs doctor for configured local MCP    |
| TypeScript plugins      | Yes                                | Yes     | Included                                | implemented | 10     | Trusted plugin loader tests                                         |
| Plugin tools            | Yes                                | Yes     | Included                                | implemented | 10     | Typed registration and execution pin tests                          |
| Plugin policy hooks     | Yes                                | Yes     | Included                                | implemented | 06, 10 | Plugin API registration tests                                       |
| Plugin custom agents    | Yes                                | Partial | Included                                | implemented | 07, 10 | Agent-profile registration tests; durable child runs remain blocked |
| Plugin custom modes     | Yes                                | Yes     | Included                                | implemented | 04, 10 | Mode registration tests                                             |
| Plugin UI actions       | Yes                                | Partial | Included within TUI contracts           | implemented | 10, 11 | UI-action registration tests                                        |
| Plugin reload/activity  | Yes                                | Partial | Included                                | implemented | 10, 16 | Reload isolation, diagnostics, and pinned-generation tests          |
| Self-extension workflow | Amp can write plugins/skills       | Yes     | Included through normal tools and trust | planned     | 10     | Pending                                                             |

## Permissions and Safety

| Feature                 | Amp July 2026         | Rika v1 | Rika v2                       | Status      | Spec   | Evidence                                                                                        |
| ----------------------- | --------------------- | ------- | ----------------------------- | ----------- | ------ | ----------------------------------------------------------------------------------------------- |
| Allow by default        | Yes                   | Yes     | Configurable personal default | planned     | 06     | Pending                                                                                         |
| Reject and continue     | Yes                   | Yes     | Included                      | implemented | 06     | Real Relay SQLite Denied restart test continues without a tool effect                           |
| Ask user                | Yes via plugin/compat | Yes     | Included durably              | implemented | 06, 07 | Approved/Denied/Always SQLite restart and duplicate-start tests                                 |
| Modify tool input       | Yes                   | Yes     | Included                      | planned     | 06     | Pending                                                                                         |
| Synthesize tool result  | Yes                   | Yes     | Included                      | planned     | 06     | Pending                                                                                         |
| Tool pattern rules      | Yes                   | Yes     | Included                      | planned     | 06     | Pending                                                                                         |
| Child-context rules     | Yes                   | Yes     | Included                      | planned     | 06, 07 | Pending                                                                                         |
| Permission dry run      | Yes                   | Partial | Included                      | planned     | 06, 13 | Pending                                                                                         |
| MCP definition policy   | Yes                   | Yes     | Included                      | planned     | 10     | Pending                                                                                         |
| Durable permission wait | Hosted behavior       | No      | Included                      | implemented | 07     | Real Relay SQLite restart tests for Approved, Denied, and Always with no duplicate tool results |

## CLI and Automation

| Feature                                  | Amp July 2026                    | Rika v1                         | Rika v2                                | Status            | Spec       | Evidence                                                                     |
| ---------------------------------------- | -------------------------------- | ------------------------------- | -------------------------------------- | ----------------- | ---------- | ---------------------------------------------------------------------------- |
| Default interactive command              | Yes                              | Yes                             | Included                               | planned           | 13         | Pending                                                                      |
| `run` subcommand                         | Equivalent execute               | Yes                             | Included                               | verified          | 13         | Packaged deterministic E2E with non-empty tool-catalog digest registration   |
| `-x`/`--execute`                         | Yes                              | Yes                             | Included                               | verified          | 13         | Packaged plain-text and streaming JSON execute E2E                           |
| Prompt from stdin                        | Yes                              | Yes                             | Included                               | planned           | 13         | Pending                                                                      |
| Ephemeral in-memory execute              | No primary user surface          | Yes                             | Included for tests and disposable runs | planned           | 13         | Pending                                                                      |
| Redirected stdout execute                | Yes                              | Partial                         | Included                               | planned           | 13         | Pending                                                                      |
| Final-message plain output               | Yes                              | Yes                             | Included                               | verified          | 13         | Packaged deterministic E2E                                                   |
| Stream JSON                              | Yes                              | Yes                             | Included                               | verified          | 13         | Packaged deterministic E2E                                                   |
| Stream reasoning events                  | Yes                              | Partial                         | Included                               | implemented       | 13         | Deterministic reasoning projection and replay harness                        |
| Multi-message JSONL input                | Yes                              | Yes                             | Included                               | implemented       | 13         | JSONL stream-input tests accept ordered string and prompt-object lines       |
| Programmatic steering                    | Yes                              | Yes                             | Included                               | implemented       | 08, 13     | Deterministic active-execution injection harness                             |
| Image JSONL input                        | Yes                              | Partial                         | Included                               | planned           | 13         | Pending                                                                      |
| Subagent event correlation               | Yes                              | Partial                         | Included                               | framework-blocked | 07, 13     | Relay proof                                                                  |
| Continue existing thread in execute mode | Yes                              | Yes                             | Included                               | planned           | 05, 13     | Pending                                                                      |
| Archive after execute                    | Yes                              | Partial                         | Included setting                       | planned           | 05, 13     | Pending                                                                      |
| Config edit                              | Yes                              | Yes                             | Included                               | implemented       | 13         | Config operation tests                                                       |
| Effective keymap output                  | Yes                              | Yes                             | Included                               | implemented       | 11, 13     | Config operation and packaged E2E tests                                      |
| Tools list/show                          | Yes                              | Partial                         | Included                               | verified          | 06, 13     | Packaged CLI contract E2E                                                    |
| Version                                  | Yes                              | Yes                             | Included                               | verified          | 13         | Packaged CLI contract E2E                                                    |
| Update                                   | Yes                              | Local installer                 | Included                               | implemented       | 13         | Isolated host-archive install, reinstall, and uninstall integration coverage |
| `last` shortcut                          | Yes                              | Resume option, no exact command | Included                               | planned           | 05, 13     | Pending                                                                      |
| `top` active-thread view                 | Yes                              | No                              | Included as local TUI/CLI view         | planned           | 05, 11, 13 | Pending                                                                      |
| `clone` repository command               | Yes                              | No                              | Omitted; shell/git handles cloning     | excluded          | 01, 13     | Product scope                                                                |
| `threads usage`                          | Yes                              | Partial                         | Included                               | verified          | 05, 13, 16 | Packaged CLI contract E2E                                                    |
| `config list`                            | Yes                              | Yes                             | Included                               | verified          | 13         | Packaged secret-redaction E2E                                                |
| Self-extension create skill              | Through normal agent/plugin work | Yes                             | Included                               | planned           | 10, 13     | Pending                                                                      |
| Self-extension create plugin             | Through normal agent/plugin work | Yes                             | Included                               | planned           | 10, 13     | Pending                                                                      |
| Extension enable/disable                 | Yes plugin controls              | Yes                             | Included                               | planned           | 10, 13     | Pending                                                                      |
| Extension rollback                       | No exact public command          | Yes                             | Included                               | planned           | 10, 13     | Pending                                                                      |
| Login/logout                             | Yes                              | Removed/local no-op history     | Omitted                                | excluded          | 01         | Decision 0001                                                                |
| Headless remote runner                   | Yes                              | No                              | Omitted                                | excluded          | 01         | Decision 0001                                                                |

## Transport and Integrations

| Feature                  | Amp July 2026                                      | Rika v1                    | Rika v2                           | Status   | Spec   | Evidence      |
| ------------------------ | -------------------------------------------------- | -------------------------- | --------------------------------- | -------- | ------ | ------------- |
| In-process Effect Stream | Internal                                           | Actor subscription adapter | Default live path                 | planned  | 05, 08 | Pending       |
| WebSocket transport      | Web remote internals unknown                       | Remote v1 used other paths | Required for any process boundary | planned  | 08     | Decision 0007 |
| SSE transport            | Public automation uses JSONL, web internal unknown | Broader v1 HTTP streaming  | Forbidden                         | excluded | 08     | Decision 0007 |
| IDE integration          | Yes                                                | Broader v1                 | Omitted                           | excluded | 01     | Decision 0001 |
| Web UI                   | Yes                                                | Broader v1                 | Omitted                           | excluded | 01     | Decision 0001 |
| Remote control           | Yes                                                | Broader v1                 | Omitted                           | excluded | 01     | Decision 0001 |
| Orbs/remote sandbox      | Yes                                                | Broader v1                 | Omitted                           | excluded | 01     | Decision 0001 |
| Hosted sharing           | Yes                                                | Broader v1                 | Omitted                           | excluded | 01     | Decision 0001 |
| Pricing/usage service    | Yes                                                | No                         | Omitted                           | excluded | 01     | Decision 0001 |

## Diagnostics and Operations

| Feature                      | Amp July 2026                | Rika v1         | Rika v2                        | Status            | Spec   | Evidence                                                                                |
| ---------------------------- | ---------------------------- | --------------- | ------------------------------ | ----------------- | ------ | --------------------------------------------------------------------------------------- |
| Local logs                   | Yes                          | Yes             | Included                       | implemented       | 16     | Correlated Effect JSON process, transport, Turn, execution, event, and tool breadcrumbs |
| Configurable log level       | Yes                          | Yes             | Level included; path fixed     | implemented       | 16     | Effective `logging.level`; fixed private diagnostics directory                          |
| Doctor command               | Diagnostic report and status | Yes             | Included                       | verified          | 13, 16 | Extracted packaged artifact returns stable secret-safe status                           |
| Local diagnostic export      | Support upload in Amp        | Partial         | Included                       | implemented       | 16     | Resident-free path, status, and private log-directory export commands                   |
| OpenTelemetry opt-in         | Internal/unknown             | No              | Omitted                        | excluded          | 16     | Native local logging selected; no custom telemetry backend                              |
| Secret redaction             | Expected                     | Yes             | Included                       | verified          | 16     | Packaged config, keymap, and doctor E2E reject configured secret disclosure             |
| Execution replay diagnostics | Hosted/internal              | Actor replay    | Included through Relay cursors | framework-blocked | 05, 16 | Relay proof                                                                             |
| Feature parity evidence      | No product feature           | Existing corpus | Required engineering artifact  | implementing      | 15     | This file and `docs/reference/V1_BASELINE.md`                                           |

## Verification Harness

| Feature                        | Amp July 2026          | Rika v1                               | Rika v2                                   | Status      | Spec       | Evidence                                                                                                                                                                                                           |
| ------------------------------ | ---------------------- | ------------------------------------- | ----------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 95% first-party coverage floor | Internal unknown       | Lower threshold                       | Required                                  | verified    | 15         | Retained global report: 98.17% statements, 95.77% branches, 96.20% functions, 98.41% lines                                                                                                                         |
| Packaged CLI E2E               | Public binary behavior | Package smoke                         | Exhaustive real-process suite             | verified    | 15         | Extracted release artifact: isolated help/parsing, execution/JSONL, thread lifecycle/search/export/usage/fork/continue, tools, skills/MCP/extensions/config/doctor/review, typed failures, SIGINT, and reopen      |
| Native OpenTUI E2E             | Public TUI behavior    | Character frames and controller tests | Real keyboard, resize, and teardown suite | verified    | 11, 15     | Packaged native PTY proves welcome/composer, keyboard submission, resize, SIGINT, and termios restoration; native renderer suite freezes character-frame and screenshot baselines                                  |
| Scripted fake model            | Internal unknown       | Fake provider tests                   | `@batonfx/test` harness                   | implemented | 15         | Real Baton TestModel and Relay SQLite cover text, reasoning, tools, malformed calls, permissions, steering, retry, cancellation, forced compaction, backend reopen, replay, and opaque terminal failure projection |
| Long agentic fake workflow     | Internal unknown       | Partial agent tests                   | Required                                  | implemented | 07, 14, 15 | Multi-agent and workflow Relay SQLite SIGKILL/restart harnesses                                                                                                                                                    |
| Fake parallel subagents        | Internal unknown       | In-process subagent tests             | Durable Relay-backed scenarios            | implemented | 07, 15     | ProductAgent/RelayExecutionBackend public-host process-death harness covers bounded concurrency, partial failure, joins, cancellation, recovery, and deduplicated projection                                       |
| Kill/restart workflow matrix   | Hosted durability      | Actor restart tests                   | Required at each implemented boundary     | implemented | 07, 14, 15 | Native Relay SQLite process harness proves delivery and research-synthesis child-handler SIGKILL/restart, revision/digest pinning, registration deduplication, and visible-effect deduplication                    |
| Live compatible-model smoke    | N/A                    | Local provider tests                  | Opt-in Effect Config suite                | planned     | 04, 15     | Pending                                                                                                                                                                                                            |
