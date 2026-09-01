# File discovery and reading

Agents use native `read` to inspect a file and `bash` with commands such as `rg` or `find` to discover files and search their contents. Rika exposes no separate model-facing search, glob, list, or grep tool. `read` returns stable line numbers, accepts an optional inclusive `read_range`, and bounds large results with explicit truncation.

Relative paths resolve from the assigned Workspace root. Absolute paths are used as given, and relative `..` segments may leave the Workspace. Path casing is corrected when exactly one on-disk spelling matches; ambiguous case fails as a conflict. Missing or unreadable files, directories, invalid ranges, invalid UTF-8, and platform failures return typed tool failures rather than another file's content.
