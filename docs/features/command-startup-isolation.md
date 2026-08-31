# Infrastructure-free command startup

Shells, scripts, and completion tooling can parse the CLI, request help or version output, and receive parser failures without opening product or Generalist databases or starting Generalist, model providers, MCP servers, plugins, the Rika Server, or OpenTUI.

Infrastructure starts only after parsing selects an operation that needs it. Diagnostic path, status, and export commands remain local file operations and do not start the Rika Server.

An interactive invocation leaves the existing terminal untouched while the client runtime loads. OpenTUI's first synchronized draw is the first Rika frame: the complete welcome surface and animated orb. There is no synthetic startup preview or intermediate “Starting Rika” state. Help, version, completions, headless Runner, noninteractive execution, and product subcommands do not initialize OpenTUI.
