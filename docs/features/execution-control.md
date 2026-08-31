# Execution control

Users may steer queued text into the active Execution and cancel durable work. Enter in the composer always submits normally: while a Turn is active, the prompt becomes a Pending Turn. Enter on a selected queue row withdraws that exact row and steers its text. Queued image input cannot be steered.

Ctrl+S steers non-empty composer text directly into the active Turn. The terminal expands pasted-text placeholders, clears the composer immediately, records the request under its generated identity, and restores the text if durable steering is rejected. The active Turn identity is carried on the action so a later Turn cannot consume an earlier request.

The composer keeps steers at most 4,096 characters as an input-box convenience. Generalist runtime message steers — for example child-settled results — are not limited by that convenience. An Execution accepts at most 64 pending steering requests. A globally unique request identity follows each command through Generalist's idempotent admission, while the returned opaque run and entry identity owns reconciliation.

A queued row is withdrawn when its durable steering admission is prepared. Generalist acceptance completes the handoff and deletes the source Pending Turn; later consumption projects exactly one user transcript entry at its event position, while terminal discard creates no transcript entry. Identity, not text, count, assistant completion, or FIFO position, distinguishes requests, so identical steering messages remain independent. An unknown admission outcome retries the same identity. A definitive rejection restores the source at its original FIFO position.

While a cancellation is pending, Enter still queues a follow-up; Pending Turns are promoted after the cancellation completes. Cancellation acknowledged before any agent response restores the submitted composer draft — drafts are captured per submission and bound to their Turn at admission, so only the cancelled Turn's draft is restored and stale terminal events cannot clear newer Turns.

Interrupt-and-send first admits a replacement prompt durably, then cancels the active Turn and promotes the replacement. If admission fails, the active Turn continues.

Generalist owns cancellation. Control requests report failure instead of pretending the action succeeded.
