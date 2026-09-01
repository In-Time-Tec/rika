# MCP servers

Users manage named local-command or remote-URL MCP definitions in the Workspace. Composition validates each definition and rejects duplicate names; local entries carry a command and arguments, while remote entries carry a URL.

`rika mcp` lists, adds, removes, enables, disables, and manages OAuth for named servers. Its `doctor` action validates and lists configuration; it does not start servers or discover their tools. A server uses either one remote URL or one local command, and mixing both forms is rejected.

Discovery can compose the Workspace configuration with an activated skill's `mcp.json`. A missing configuration file is an empty set; malformed definitions and disabled names that match no server fail discovery. The four native model tools do not mount MCP servers. MCP configuration and credentials remain Executor-local extension state unless a separate supported execution surface consumes them.
