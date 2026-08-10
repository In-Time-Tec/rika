# A delegating parent uses durable settlements rather than polling

**Gain:** `rika.agents.spawn` admits a child and returns immediately. Each terminal child writes one deduplicated settlement to the parent Run's durable inbox, including its terminal status and a bounded result. A later cell pages `rika.agents.inbox` by sequence, so a cell neither sleeps nor repeatedly inspects unchanged child state, and delivered mailbox envelopes do not erase the settlement record.

**Cost:** a settlement does not start or resume a parent Execution. It reaches an active parent at a model-turn boundary and remains readable from later cells of that Run; product-level continuation after the parent Execution ends is a separate lifecycle decision. Oversized successful outcomes require one snapshot read and a Rika artifact write before the inbox returns a recoverable handle.

**Rejected:** waiting inside `inspectAll` put child latency inside the cell deadline, occupied the parent's execution fiber, and taught models to poll again after the bounded wait elapsed. Exposing Baton's `Runtime.snapshot` recovery marker directly was also rejected because the kernel cannot call that internal API; Rika converts it to its own artifact handle and bounded slicing workflow.
