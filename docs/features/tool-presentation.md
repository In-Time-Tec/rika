# Tool presentation

The model emits one action, the `typescript` cell, so the transcript's action rows are cells and the subagent cards attached to them. Cells stay in source order, appear once while running, and are updated in place when they complete.

Unselected summaries show the action or agent identity as primary text and mute statuses, targets, counts, and context at every nesting depth. The agent identity stays primary while its lifecycle wording is muted, including in nested rows.

Cell rows own their own collapsed line, expansion, output, notices, files, and attached image blocks. Subagent cards own delegated-task detail and lifecycle status. Diff and process bodies keep their existing presentation, driven by the cell's file entries and process rows rather than by parsing cell source.
