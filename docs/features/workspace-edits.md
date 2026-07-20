# Workspace edits

The canonical model-visible local tools are `read`, `edit`, `write`, and `bash`. Agents use `edit` to replace exact text in existing UTF-8 files and `write` to create or overwrite UTF-8 files inside the Workspace. `edit` requires one unique match unless `replace_all` is true. There is no model-visible `apply_patch` tool.

Outside-Workspace paths and edit paths containing symbolic links fail, as do missing or ambiguous matches. Workspace edits are allowed without confirmation. Edit and write calls are mutations and are not safe to retry when their result is unknown.
