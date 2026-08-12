# Tool presentation

The model uses the `typescript` cell for its persistent RLM environment and Baton's blocking child tools for durable delegation. Cells stay in source order, appear once while running, and are updated in place when they complete. Child-tool plumbing is hidden behind subagent cards; direct children appear at their parent's transcript level and descendants nest beneath the child that delegated them.

Unselected summaries show the action or agent identity as primary text and mute statuses, targets, counts, and context at every nesting depth. The agent identity stays primary while its lifecycle wording is muted, including in nested rows.

Cell rows own their own collapsed line, expansion, output, notices, files, and attached image blocks. Subagent cards own delegated-task detail and lifecycle status. Diff and process bodies keep their existing presentation, driven by the cell's file entries and process rows rather than by parsing cell source.
