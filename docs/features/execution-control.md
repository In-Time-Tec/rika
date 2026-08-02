# Execution control

Users may steer text into the active Execution and cancel durable work. Pressing Enter while a Turn is active queues the prompt as a durable Pending Turn. Steering happens explicitly: Ctrl+S steers the composer text directly, and pressing Enter on a selected queued message converts that Pending Turn into steering, removing it from the queue. Image input cannot be converted to steering.

Steering a message renders a `steering:` row above the composer from the moment it is sent, keyed by the backend receipt's steering sequence once accepted. The row is removed only when the durable `steering.delivered` event reports the message was consumed into the next model turn; the transcript then projects each delivered steering message as its own user entry at its exact event position, so several steered messages appear as distinct history entries. If the Turn settles before delivery, undelivered steering text is restored into an empty composer instead of being silently dropped.

While a cancellation is pending, Ctrl+S is inert and Enter continues to queue durably; queued Turns are promoted after the cancellation completes. Cancellation acknowledged before any agent response restores the submitted composer draft — drafts are captured per submission and bound to their Turn at admission, so only the cancelled Turn's draft is restored and stale terminal events cannot clear newer Turns.

Interrupt-and-send first admits a replacement prompt durably, then cancels the active Turn and promotes the replacement. If admission fails, the active Turn continues.

Relay owns cancellation. Control requests report failure instead of pretending the action succeeded.
