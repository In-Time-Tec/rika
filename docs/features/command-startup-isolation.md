# Infrastructure-free command startup

Shells, scripts, and completion tooling can parse the CLI, request help or version output, and receive parser failures without opening product or TenetKit databases or starting TenetKit, model providers, MCP servers, plugins, the Rika Server, or OpenTUI.

Infrastructure starts only after parsing selects an operation that needs it. Diagnostic path, status, and export commands remain local file operations and do not start the Rika Server.

An interactive invocation paints one complete synchronized startup frame directly from the executable entry point before loading the Effect client runtime. The preview is limited to TTY invocations that enter the TUI; help, version, completions, headless Runner, noninteractive execution, and product subcommands produce no terminal frame. The real OpenTUI renderer replaces the preview and remains the sole owner of subsequent terminal state.
