# Infrastructure-free command startup

Shells, scripts, and completion tooling can parse the CLI, request help or version output, and receive parser failures without opening product or TenetKit databases or starting TenetKit, model providers, MCP servers, plugins, the Rika Server, or OpenTUI.

Infrastructure starts only after parsing selects an operation that needs it. Diagnostic path, status, and export commands remain local file operations and do not start the Rika Server.
