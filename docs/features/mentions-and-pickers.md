# File and Thread mentions

Typing `@` opens Workspace file completion and inserts the chosen path into the draft. Typing `@@` switches to Thread completion and inserts the chosen Thread reference.

Pickers filter as the user types, preserve the surrounding draft, and expose loading and empty states. Resolved mentions become execution context; the composer keeps only the typed reference.

Only typed text is scanned for mentions. Pasted text keeps its own prompt part, so an `@` inside a paste stays literal and never resolves as a file, guidance, image, or Thread reference. A paste that would otherwise be short enough to inline collapses into a pasted-text attachment when it contains mention syntax.
