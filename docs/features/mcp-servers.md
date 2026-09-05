# MCP servers

Users manage named local-command or remote-URL MCP definitions in the Workspace. Composition validates each definition and rejects duplicate names; local entries carry a command and arguments, while remote entries carry a URL.

`rika mcp` lists, adds, removes, enables, disables, and manages OAuth for named servers. Its `doctor` action validates and lists configuration; it does not start servers or discover their tools. A server uses either one remote URL or one local command, and mixing both forms is rejected.

Discovery can compose the Workspace configuration with an activated skill's `mcp.json`. A missing configuration file is an empty set; malformed definitions and disabled names that match no server fail discovery.

## Specialist tool grants

The root retains exactly four native tools. To authorize an enabled Workspace MCP tool for a specialist, add an explicit raw-tool allowlist in `.rika/mcp.json`:

```json
{
  "servers": {
    "docs": {
      "command": "docs-mcp",
      "args": [],
      "specialists": {
        "Librarian": ["search_docs"],
        "Task": ["search_docs"]
      }
    }
  }
}
```

Supported role keys are `Oracle`, `Librarian`, `Painter`, `Review`, `Surgeon`, and `Task`. Missing grants deny access; there are no wildcards. `rika mcp list` displays grants without connection credentials. Skill-provided MCP definitions are not mounted by this execution path.

The Executor discovers granted tools when publishing its Workspace capability snapshot. Restart the Runner after changing configuration or the server's tool inventory. Orb discovery and calls execute in the workspace-user subprocess, never in the privileged host or hosted API. Local commands default to the Workspace directory; relative `cwd` values resolve there. HTTP headers and OAuth tokens remain Executor-local; OAuth uses that user's `.config/rika/mcp-oauth.json` store. Complete interactive OAuth login before execution.

Admission pins the catalog, configuration digest, role grants, tool names, descriptions, and input/output schema identity into the durable executable. Recovery reconstructs that catalog, not a fresh discovery. Before each call, the Executor rereads enabled state and grants, checks configuration identity, and compares the discovered descriptor on the same scoped connection used for the call. Removed tools, changed schemas, disabled servers, or revoked grants fail closed. Discovery is all-or-nothing: an unavailable granted server never yields a partial catalog. Descriptors are limited to 16 KiB each and catalogs to 32 KiB.

Descriptions, schemas, and returned content are untrusted server data, not instructions. Connection configuration is never included in descriptors. Known configured environment/header values are rejected if echoed in descriptors or results; this is not a general secret-detection system. Stdio stderr is suppressed. JSON inputs are checked against the pinned schema. Results retain Generalist's MCP result normalization and are limited to 16 KiB; calls have a 60-second deadline. Interrupted connections are closed. A failed or disconnected call may already have changed external state: it is reported as unknown, never automatically repeated. Remote calls retain existing durable operation keys, Executor receipts, assignment fencing, and cancellation routing.

The capability field is optional on the existing protocol: a new API grants no MCP tools to an old Runner; an old API ignores the new advertisement and continues native execution. Only a catalog-advertising Executor receives the new private MCP request variants. Existing native executable registrations remain unchanged; an MCP-enabled executable requires the upgraded resolver.
