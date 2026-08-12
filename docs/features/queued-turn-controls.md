# Queued Turn controls

Input submitted while a Turn is active appears in a compact queue joined to the composer. Up enters the queue from newest toward oldest; Down moves toward newer items and then returns to the composer. Escape leaves queue navigation.

Enter while a Turn is active admits the composer text as a steering item: it appears on that same row as `steering: <text>` and is delivered after the current model turn finishes its tool batch. Alt+Enter admits a follow-up Pending Turn, which stays a plain queued row and is promoted after the active Execution settles. Enter on a selected follow-up flips that row to steering in place. Backspace dequeues a row and Ctrl+E loads it for editing. Enter saves an edit and Escape cancels it. Queue controls act only on a selected row, and queued prompts remain outside the transcript until they are steered into the active Turn or promoted as their own Turn.

Steering keeps the Pending Turn in the queue and journals it in the same durable admission outbox used by direct steering. An unknown Baton outcome is retried with the same request identity after interruption. The opaque Baton receipt is kept until the exact entry is consumed or discarded; consumption removes the row and projects its user entry into the transcript. A definitive rejection flips the row back to a follow-up Pending Turn instead of deleting it.
