# Threads and Turns

A Thread is Rika's durable user-facing conversation and work record in one Workspace. It carries its Workspace, title, labels, pin and archive state. A Turn is one user instruction and its top-level Execution; it stores the prompt and structured attachments, lifecycle state, pinned execution route and extension context, and the latest known TenetKit cursor.

Rika owns Thread and Turn records. A Turn moves through `accepted`, `queued`, `running`, `waiting`, and one of `completed`, `failed`, or `cancelled`; normal lifecycle updates do not replace terminal state, while a versioned refold atomically adopts a contradictory terminal outcome proven by TenetKit's durable event history. Queued instructions are Pending Turns and do not appear in the transcript until their Execution starts. Steering becomes transcript history only when TenetKit's durable lifecycle identifies the consumed request; discarded requests never become transcript entries.
