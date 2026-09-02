# Model routing

Rika maps each configured mode name to a main route, an Oracle route, and optional per-agent routes. A direct route names `provider` and `model`; it does not need a model alias. `effort` defaults to the inherited route's effort or `medium`, and `fast` is optional. A new mode requires `main`; an omitted `oracle` inherits `main`. Task and Surgeon inherit main, while Librarian, Painter, and Review inherit Oracle. Any inherited agent route can be replaced under the mode's `agents` map.

`modes` may contain any non-empty names. Once a global or Workspace file declares `modes`, those user-defined maps form the complete effective mode set instead of extending the built-in `low`, `medium`, `high`, and `ultra` set. Workspace entries merge over global entries by mode, role, and agent. `defaultMode` must name a mode in that final set.

Hosted Threads resolve routes on the API from the built-in `low`, `medium`, `high`, and `ultra` modes pinned to the owner's OpenAI account; settings files never reach the API. Passing any other name with `--mode` fails with `Mode "<name>" is not a hosted mode; hosted modes are low, medium, high, ultra`.

`modelRoutes.title` and `modelRoutes.compaction` independently select the thread-title and compaction-summary models. They accept the same direct or alias route shape. Each accepted Turn pins every resolved model, ordered candidate list, options, limits, authentication kind, non-secret credential identity, and provider connection. Later settings or account changes affect only newly admitted work.

A `modelAliases` entry is only needed for a reusable bundle: ordered fallback candidates, custom limits, display metadata, or effort-specific provider options. It names a provider, candidates, and either the `openai` or `claude` preset or its own `efforts`. Custom efforts require custom limits. A route selects a bundle with `{ "alias": "name" }`; an alias is never required merely to assign one model to a mode or agent.

Missing providers or aliases, unavailable alias variants, corrupt credentials, and unregistrable routes fail before execution. Transient provider failures show their retry reason; terminal failures preserve technical details without displaying credential values.

```json
{
  "defaultMode": "deep-review",
  "modes": {
    "quick": {
      "main": { "provider": "openai", "model": "gpt-5.6-luna", "effort": "high" }
    },
    "deep-review": {
      "main": { "provider": "openai", "model": "gpt-5.6-sol", "effort": "xhigh" },
      "oracle": { "provider": "anthropic", "model": "claude-opus-4-1", "effort": "high" },
      "agents": {
        "task": {
          "provider": "bedrock",
          "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
          "effort": "high"
        },
        "librarian": { "provider": "openrouter", "model": "openai/gpt-5.4", "effort": "medium" }
      }
    }
  },
  "modelAliases": {
    "opus-fallbacks": {
      "preset": "claude",
      "provider": "anthropic",
      "candidates": ["claude-opus-4-1", "claude-opus-4"],
      "displayName": "Opus fallbacks"
    }
  },
  "modelRoutes": {
    "title": { "provider": "openai", "model": "gpt-5.6-luna", "effort": "low" },
    "compaction": { "alias": "opus-fallbacks", "effort": "high" }
  }
}
```
