# MCP servers

Users manage named local-command or remote-URL MCP definitions in the Workspace. Composition validates each definition and rejects duplicate names; local entries carry a command and arguments, while remote entries carry a URL.

`rika mcp` lists, adds, removes, enables, and disables named servers. Its `doctor` action validates and lists configuration; it does not start servers or discover their tools. A server uses either one remote URL or one local command, and mixing both forms is rejected.

An Execution discovers the Workspace configuration together with every activated skill's `mcp.json` into one server set. A missing configuration file is an empty set; a malformed one, or a disabled name that matches no server, fails discovery. Enabled servers reach the model as `rika.mcp`, and the prompt costs their names only, never their tool schemas. Enabling or disabling a server changes the kernel bindings digest and therefore starts a new kernel epoch.
