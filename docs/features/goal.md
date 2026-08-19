# Goal

A Thread may have one durable goal: an objective of up to 4,096 characters, a status of `active`, `paused`, `complete`, or `errored`, an optional token and wall-clock budget, and accumulated usage in tokens, elapsed milliseconds, and turns. It is one row per Thread and survives Turns and Server restart.

A cell creates a goal with `rika.goal.create`, reads it with `rika.goal.get`, and ends it with `rika.goal.complete`. The Thread is the ambient session and is never a field the cell may supply. A second create while a goal is active is refused, and completing when no goal is active is refused. Only `complete` reaches the complete status, so a goal ends when the agent says it ends, and completion may record a summary.

Recording a turn adds its tokens, elapsed time, and one turn to usage. A goal that has spent its token or wall-clock budget moves to `paused` rather than `complete`; a goal with no budget never exhausts. While a goal is active, Rika supplies a continuation instruction naming the objective and stating that it is completed explicitly with `rika.goal.complete`.

The TUI shows the active goal in the top-left corner as `Goal 32s`, `Goal 59m`, `Goal 23h`, or `Goal 2 days`, styled like the bottom-left status line and drawn with its own animated frame set, disjoint from the loader and status spinners. Elapsed time is always derived from the goal's start and the current time, never accumulated. The indicator appears only while the goal is `active` and only at the width the context meter needs, and its timer exists only while it is showing, so an idle Rika with no goal runs no interval.
