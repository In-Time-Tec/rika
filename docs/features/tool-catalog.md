# Built-in tool catalog

`rika tools list` prints Rika's static built-in tool definitions. `rika tools show <name>` prints one built-in definition, including its description, timeout, output limit, and presentation metadata.

The catalog is inspection-only and returns bounded, secret-safe output. It does not resolve mode, specialist, extension, MCP, or Workspace policy into an effective execution toolkit. An unknown tool name or invalid mode fails explicitly rather than returning an empty tool description.
