# Model routing

Rika maps model aliases to ordered provider candidates for the main and Oracle routes. A mode pins both routes: Task children use main, while Oracle, Librarian, Painter, Review, and ReadThread children use Oracle. Child tools never choose a model or reasoning effort.

Each accepted Turn pins the chosen models and non-secret provider settings. Missing aliases, unavailable variants, or routes that cannot be registered fail before execution starts; later configuration changes apply only to work not yet admitted.

A `modelAliases` entry describes its own model. It names a provider, ordered non-empty candidates, and either a `preset` or its own `efforts`, never both. Presets are `openai` and `claude`; each supplies the request-option family and default limits for that family, not a product identity. An alias may set `limits` to replace the preset's block, and `displayName` to control how it is shown; `displayName` falls back to the alias name. Declared `efforts` must use request options the provider's protocol accepts, and require `limits`.

`modelRoutes.modes` sets the main and Oracle route for a mode. A role accepts an alias name, or an object with `alias` and an optional `effort` and `fast`; omitted values keep the mode's built-in policy. `modelRoutes.title` routes thread-title generation the same way. Compaction summaries are fixed to Sol/xhigh.

A `base` naming a built-in alias still works and takes that alias's limits, but it is deprecated and reported as a configuration diagnostic.

```json
{
  "modelAliases": {
    "gate-sonnet": {
      "preset": "claude",
      "provider": "anthropic",
      "candidates": ["claude-sonnet-5"],
      "displayName": "Sonnet 5"
    }
  },
  "modelRoutes": {
    "modes": { "high": { "main": { "alias": "gate-sonnet", "effort": "high" } } },
    "title": "gate-sonnet"
  }
}
```
