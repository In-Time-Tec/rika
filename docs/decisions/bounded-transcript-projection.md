# Full-timeline delivery with an in-memory cap

Rika stores a disposable semantic projection of each thread. The interactive
TUI originally reconciled a small bounded keyed window (120 units) with
directional pages so rendering and live patches would not grow with complete
Thread history. That made scroll-back a blocking server round trip and the
transcript feel paginated.

The interactive client now receives the **full timeline up to a generous bound**
(payload-bounded snapshot; 20,000-unit client memory cap) and virtualizes
rendering instead: only the units intersecting the viewport are mounted as
renderables, so frame cost is constant regardless of transcript size. The
oldest content beyond the cap is evicted from the client (never split across a
parent-child subtree) and stays durable server-side; it is simply not reachable
from the TUI. This matches how leading terminal coding agents (OpenCode, Pi,
Amp) treat history: held in memory, scroll never performs I/O, and content is
bounded by compaction and truncation rather than by navigation.
