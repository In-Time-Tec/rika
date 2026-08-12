# Execution control

Users may steer text into the active Execution and cancel durable work. Enter while a Turn is active steers the composer text: the Pending Turn is admitted with steering delivery and shown on its own queue row as `steering: <text>` before Baton is asked to deliver it. Alt+Enter queues a follow-up Pending Turn that is promoted only after the Execution settles. Enter on a selected follow-up converts that Pending Turn to steering in place, keeping the same row. Image input cannot be converted to steering.

Steering text is limited to 4,096 characters, and an Execution accepts at most 64 pending steering requests. A globally unique request identity follows each command through Baton's idempotent admission, while the returned opaque run and entry identity owns reconciliation.

A steering row remains in the queue until Baton records that exact entry as consumed or discarded. Consumption removes the row and projects exactly one user transcript entry at its event position. Discard removes the row without creating a transcript entry. Identity, not text, count, assistant completion, or FIFO position, distinguishes requests, so identical steering messages remain independent. A definitive admission rejection flips the row back to a follow-up Pending Turn; terminal completion does not guess delivery or restore accepted text.

While a cancellation is pending, Alt+Enter still queues a follow-up and Enter still steers; follow-up Turns are promoted after the cancellation completes. Cancellation acknowledged before any agent response restores the submitted composer draft — drafts are captured per submission and bound to their Turn at admission, so only the cancelled Turn's draft is restored and stale terminal events cannot clear newer Turns.

Interrupt-and-send first admits a replacement prompt durably, then cancels the active Turn and promotes the replacement. If admission fails, the active Turn continues.

Baton owns cancellation. Control requests report failure instead of pretending the action succeeded.
