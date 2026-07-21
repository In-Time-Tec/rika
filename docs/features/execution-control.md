# Execution control

Users may steer text into the active Execution, cancel durable work, and answer permission or tool-approval waits. Pressing Enter while a Turn is active steers the composer text instead of queueing a durable Turn; Ctrl+S steers explicitly. Steering targets the Turn that was active when Enter was pressed and is rejected rather than retargeted if that Turn has settled. Steering a Pending Turn removes it from the queue, and image input cannot be converted to steering; composer submissions with images queue durably instead.

Accepted steering renders as a `steering:` row above the composer, keyed by the backend receipt's steering sequence. The row is removed only when the durable `steering.delivered` event reports the message was consumed into the next model turn; the transcript then projects the delivered text as an ordinary user entry at its exact event position. If the Turn settles before delivery, undelivered steering text is restored into an empty composer instead of being silently dropped.

While a cancellation is pending, Enter submits a durable Pending Turn rather than steering, and Ctrl+S is inert; the queued Turn is promoted after the cancellation completes. Cancellation acknowledged before any agent response restores the submitted composer draft — drafts are captured per submission and bound to their Turn at admission, so only the cancelled Turn's draft is restored.

Interrupt-and-send first admits a replacement prompt durably, then cancels the active Turn and promotes the replacement. If admission fails, the active Turn continues.

Relay owns cancellation and wait resolution. Permission choices are allow, deny, or always allow; for a tool-approval wait, both allow choices approve that request. Control requests report failure instead of pretending the action succeeded, and unresolved actionable waits keep the Turn in `waiting` so they can resume after reconnect or restart.
