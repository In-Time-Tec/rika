# Queued Turn controls

Input submitted while a Turn is active appears in a compact queue joined to the composer. Up enters the queue from newest toward oldest; Down moves toward newer items and then returns to the composer. Escape leaves queue navigation.

Enter steers the selected queued prompt into the active Turn, Backspace dequeues it, and Ctrl+E loads it for editing. Enter saves an edit and Escape cancels it. Queue controls act only on a selected row, and queued prompts remain outside the transcript until their Turn starts. Queue navigation and controls work whenever the queue is non-empty, whether or not a Turn is active. Enter steers only while a Turn is active; with no active Turn the row stays queued.

Queued steering atomically moves the Pending Turn into the same durable admission journal used by direct steering. An unknown Baton outcome is retried with the same request identity after interruption. Acceptance keeps the opaque Baton receipt until exact consumption or discard is projected. Definitive rejection restores the exact Pending Turn, and the rejection remains recoverable until durable queue promotion owns that Turn.
