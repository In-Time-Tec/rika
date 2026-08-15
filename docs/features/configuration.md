# Layered configuration

Rika reads global settings from `~/.config/rika/settings.json` and Workspace settings from `.rika/settings.json`. Workspace values take precedence over global values, with map-shaped settings merged by key; invalid files or unsupported fields fail configuration loading instead of being ignored. The server watches both files and restarts itself when a valid edit lands, so effective settings update without a manual restart; an invalid edit is ignored and the previous settings stay in force.

Recursive delegation defaults to four active direct children per parent and four child levels. `maxDepth` counts edges from the root, so `0` disables subagents, `1` permits only root children, and `2` also permits grandchildren. `maxSubagents` is each parent's concurrent direct-child capacity, not a lifetime or tree-wide limit. Excess members of an admitted group wait in a durable queue and start as that parent's children settle; every recursively capable child receives the same independent capacity. Both settings accept integers from 0 through 1024.

```json
{
  "subagents": {
    "maxDepth": 4,
    "maxSubagents": 4
  }
}
```

`rika config list` prints effective settings and their sources, using presence markers rather than credential values. `rika config edit` opens the global file, `rika config edit --workspace` opens the Workspace file, and `rika config keymap` prints the effective key bindings; provider endpoint and credential-environment rules are separate from this general precedence contract.

Web search providers are configured by provider ID:

```json
{
  "webSearch": {
    "providers": {
      "parallel": { "apiKey": "..." },
      "exa": { "apiKey": "..." },
      "firecrawl": { "apiKey": "..." },
      "github": { "apiKey": "..." }
    }
  }
}
```

When a provider is absent from settings, Rika falls back to `PARALLEL_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, or `GITHUB_TOKEN`. Settings take precedence. Effective settings expose only `{ "configured": true }` presence markers, never credential values.
