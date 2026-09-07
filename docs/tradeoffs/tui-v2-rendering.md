# Bounded rendering in the standalone TUI

The SolidJS TUI retains the full offline Thread state but mounts at most 250
transcript groups at once. It opens on the newest group window. Earlier and newer
controls, Page Up/Page Down at the window boundaries, Home, End, and detail
navigation expose the retained history without allocating native text buffers for
every historical message. Scrolling away from the bottom anchors the current
window while new messages arrive; End resumes following the latest output.

The cost is a windowed history scrollbar rather than a scrollbar representing the
entire Thread. The controls explicitly show how many groups lie outside the
window. There are no estimated-height spacers or silently discarded messages.
Small transcripts have no paging controls and retain the reference layout.
Expansion state survives window changes, and toggling all details computes its
defaults in one linear pass rather than searching the full history for every ID.

The bound applies to groups, not bytes or children within a group. A single huge
expanded tool group, a very large pending queue, or exceptionally large output can
still consume substantial memory. The full client state and group index also grow
with retained history. This is not a constant-memory execution engine or a claim
of unlimited scale.

The command palette uses fixed-height virtual rows instead. It mounts a small
overscanned window while preserving the complete native scroll range, global
selection indices, and mouse-wheel behavior. Its action list is not constructed
while the palette is closed.

Stable per-item projections prevent a streamed tool-output update from remounting
unrelated history. Tool bodies are parsed on demand; content width and contextual
sidebar presence are shared memos rather than per-text-block scans. Rich text is
assigned to the native text buffer through its ref because this OpenTUI Solid
release stringifies objects passed through the JSX `content` property. Frame and
colored-span tests cover the rendered result, not just TypeScript acceptance.

Animation still has a bounded 100 ms clock while a Thread is active. Completed
headers do not subscribe to that clock, and clipped headers keep a stable glyph
instead of invalidating native text buffers. Visible headers resume animation
after scrolling into view. The welcome orb intentionally animates unless
`--no-animate` is selected.

The performance harness under `apps/tui-v2/test/performance` measures synthetic
rendering, not model execution, hosted queue throughput, or terminal-emulator I/O.
See [the measured results](../performance/tui-v2-rendering.md) for workload counts,
raw samples, limitations, and the baseline revision.
