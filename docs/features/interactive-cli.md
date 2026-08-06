# Interactive CLI entry

Running `rika` without a subcommand opens the terminal interface for a local developer. The default entry accepts an initial prompt plus `--mode` (`low`, `medium`, `high`, or `ultra`), `--workspace`, and `--thread`; invalid flags or identifiers fail through the CLI rather than silently changing the selection.

The selected Workspace and Thread are passed to the server-backed interactive session. Stream flags are rejected unless execution is explicitly noninteractive.
