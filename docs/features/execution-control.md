# Execution control

Users may steer text into the active Execution and cancel durable work. Pressing Enter while a Turn is active queues the prompt as a durable Pending Turn. Steering happens explicitly: Ctrl+S steers the composer text directly, and pressing Enter on a selected queued message converts that Pending Turn into steering, removing it from the queue. Image input cannot be converted to steering.

Steering appears as a `steering:` row above the composer only after Baton's durable accepted fact is projected. A globally unique request identity follows the command through Baton's idempotent admission, while the returned opaque run and entry identity owns reconciliation. Steering text is limited to 4,096 characters, and an Execution accepts at most 64 pending steering requests.

An accepted row remains pending until Baton records that exact entry as consumed or discarded. Consumption removes the pending row and projects exactly one user transcript entry at its event position. Discard removes the row without creating a transcript entry. Identity, not text, count, assistant completion, or FIFO position, distinguishes requests, so identical steering messages remain independent. A definitive admission rejection restores direct composer input or the queued Pending Turn; terminal completion does not guess delivery or restore accepted text.

While a cancellation is pending, Ctrl+S is inert and Enter continues to queue durably; queued Turns are promoted after the cancellation completes. Cancellation acknowledged before any agent response restores the submitted composer draft — drafts are captured per submission and bound to their Turn at admission, so only the cancelled Turn's draft is restored and stale terminal events cannot clear newer Turns.

Interrupt-and-send first admits a replacement prompt durably, then cancels the active Turn and promotes the replacement. If admission fails, the active Turn continues.

Baton owns cancellation. Control requests report failure instead of pretending the action succeeded.
