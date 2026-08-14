# Skills

Rika discovers named skills from global and Workspace skill directories, with a Workspace skill overriding a global skill of the same name. Listings expose sorted metadata without loading every body.

A skill is loaded only when inspected, at which point Rika reads its instructions and sorted files beneath its directory. Missing skills, deleted or unreadable content, and resource paths that escape the skill directory fail inspection; skill creation is not a supported agent action.

`rika skills list` and `inspect` expose discovered skills. `add` copies an existing skill directory into the Workspace without overwriting another skill, and `remove` deletes the named Workspace skill. A skill that also ships a Rika package manifest is executable and may be importable inside a cell.
