# Workspace edits

The canonical model-visible local tools are `read`, `edit`, `write`, and `bash`. Agents use `edit` to replace exact text in existing UTF-8 files and `write` to create or overwrite UTF-8 files anywhere the user running Rika can write. `edit` requires one unique match unless `replace_all` is true. There is no model-visible `apply_patch` tool.

Symbolic links are followed. `edit` requires an existing regular file and `write` refuses an existing directory, device, or socket; missing or ambiguous matches and paths whose casing matches two on-disk spellings fail. `write` corrects the casing of existing parent directories but keeps the requested spelling for a new file. Workspace edits are allowed without confirmation. Edit and write calls are mutations and are not safe to retry when their result is unknown.
