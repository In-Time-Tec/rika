# Interactive CLI entry

Running `rika` without a subcommand opens the terminal interface for a local developer. The default entry accepts an initial prompt plus `--mode <name>`, `--workspace`, and `--thread`. Mode names come from effective configuration rather than a fixed CLI enum; an unknown explicit name fails route resolution instead of silently selecting another mode.

The selected Workspace and Thread are passed to the server-backed interactive session. Stream flags are rejected unless execution is explicitly noninteractive.
