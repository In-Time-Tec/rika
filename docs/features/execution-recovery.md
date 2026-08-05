# Execution recovery

On startup and reopen, Rika reconciles nonterminal Turns and stale read state against Baton. It inspects the durable Execution, backfills bounded event pages, then follows from the newest stored cursor; applying an event and advancing the projection checkpoint is idempotent.

Following stops at a Baton terminal event. Missing or interrupted transport never invents completion, and stale local terminal updates cannot replace a known terminal result. A disposable projection or Thread summary may be rebuilt from Baton after loss or mismatch.
