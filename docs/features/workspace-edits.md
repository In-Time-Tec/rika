# Workspace edits

Agents edit from a cell. `rika.workspace.replace` replaces exact text in an existing UTF-8 file, `rika.workspace.write` creates or overwrites a UTF-8 file anywhere the user running Rika can write, and `rika.edits.apply` applies between one and sixty-four replacements as one operation. A replace requires one unique match unless `replaceAll` is true.

Symbolic links are followed. `replace` requires an existing regular file and `write` refuses an existing directory, device, or socket; missing or ambiguous matches and paths whose casing matches two on-disk spellings fail. `write` corrects the casing of existing parent directories but keeps the requested spelling for a new file. Workspace edits are allowed without confirmation. Edit and write calls are mutations and are not safe to retry when their result is unknown.
