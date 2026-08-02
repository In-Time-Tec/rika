# File discovery and reading

Agents use `grep` and `read` to inspect the current Workspace. Search skips `.git` and `node_modules`, returns at most one thousand matches, and reads bounded UTF-8 line ranges with a default of five hundred and a maximum of two thousand lines.

Read paths may point anywhere the user running Rika can read, including absolute paths outside the Workspace. Path casing is corrected when exactly one on-disk spelling matches; two spellings that differ only by casing fail as a conflict. The Workspace filename fallback applies only to unresolved paths that are already inside the Workspace. Invalid regular expressions, missing or unreadable files, invalid ranges, and platform failures return typed tool errors; large results are truncated to the tool's output bound.
