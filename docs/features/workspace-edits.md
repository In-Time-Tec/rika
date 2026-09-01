# Workspace edits

Agents use native `edit` to replace exact text in an existing UTF-8 file. Relative paths start at the selected Workspace; absolute paths are used as given, and relative `..` segments may leave the Workspace. A replacement requires one unique match unless `replace_all` is true. The tool refuses missing text, ambiguous matches, invalid UTF-8, and directories. A successful response includes the authoritative unified diff. The tool runs with the invoking OS user's filesystem authority and is not a sandbox.

`edit` is unsafe to replay across an ambiguous provider boundary. If its terminal result is unobserved, the operation remains unknown and the agent must read the file before deciding whether another edit is needed.
