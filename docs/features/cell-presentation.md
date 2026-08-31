# Cell presentation

A cell is one transcript block. Its collapsed line is a glyph, a one-line summary, and muted details: the source line count, the duration, and `truncated` when the source or either output channel hit a bound. The summary is the first meaningful source line, ignoring blank and comment-only lines. A cell whose only meaningful line is a `Bun.$` or `Bun.spawn` statement renders with the shell glyph; everything else renders as TypeScript.

Expanded, a cell shows its syntax-highlighted source, then stdout, stderr, the result value, any error name, message, and stack, then its notices, then the dropped byte and event counts. Running cells show the spinner and settle to complete, failed, cancelled, or unknown. Cells still running when their Run settles are settled with it.

Notices come from kernel events, never from parsing cell source: the kernel starting, a restart with its reason and epoch, restored binding names, and lost binding names with a reason. Nested operations append their kind and status as activity notices. A kernel restart also raises its own transcript notification, because bindings from earlier cells may be gone.

Cell display output is projected by media type. An image becomes an image attachment block beneath the cell. A diff or patch becomes a file entry on the cell carrying its path, add or update kind, bounded patch, and added and removed line counts.

Child orchestration does not run inside a cell. Generalist's blocking child tools suspend and resume the parent Run durably, while child-tree events drive each subagent card and its nested activity without parsing cell source or correlating child identity to JavaScript execution.
