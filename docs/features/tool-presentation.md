# Tool presentation

The model uses exactly four native workspace tools: `bash`, `edit`, `read`, and `shell_command_status`. Generalist supplies blocking `run_child` and `run_child_group` only when the persisted child policy permits delegation.

Native tool rows stay in source order, appear once while running, and update in place when they settle. Their flat summaries use the action as primary text and muted status, target, range, truncation, and duration metadata; process identifiers are not shown. A read row labels the line range it actually returned. `shell_command_status` updates the originating Bash row instead of adding a second activity row. Expanded edit rows show the authoritative diff. Expanded command rows show bounded retained output; expanded read rows show a numbered, syntax-highlighted listing. The expand marker (▸/▾) sits at the end of a tool, subagent, or group row.

Child plumbing is hidden behind neutral subagent cards. Direct children appear at their parent's transcript level and descendants nest beneath the child that delegated them. A group uses an `N agents` label, ordered members, truthful mixed outcome counts, and explicit waiting and resumed lifecycle.
