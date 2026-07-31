# MCP servers

Users manage named local-command or remote-URL MCP definitions in the Workspace. Composition validates each definition and rejects duplicate names; local entries carry a command and arguments, while remote entries carry a URL.

`rika mcp` lists, adds, removes, enables, and disables named servers. Its `doctor` action validates and lists configuration; it does not start servers or discover their tools. A server uses either one remote URL or one local command, and mixing both forms is rejected.
