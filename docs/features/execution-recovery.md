# Execution recovery

On startup and reopen, Rika reconciles nonterminal Turns and stale read state against Relay. It inspects the durable Execution, backfills bounded event pages, then follows from the newest stored cursor; applying an event and advancing the projection checkpoint is idempotent.

Following stops at a Relay terminal event or an actionable permission request. Missing or interrupted transport never invents completion, and stale local terminal updates cannot replace a known terminal result. A disposable projection or Thread summary may be rebuilt from Relay after loss or mismatch.

The starting context baseline of an execution derives only from its pinned agent snapshot, so recovery in a replacement process reassembles it byte-for-byte. If Relay re-enters an execution's startup before its first durable chat checkpoint after tool or delegation work already started, Rika fails that execution instead of replaying startup with a fresh model turn; independently spawned children continue to their own outcomes. Inspection of a terminal execution reports no pending tools and resolves each child's live status, so delegation attempts orphaned by a dead resident cannot block quiescence or admission.
