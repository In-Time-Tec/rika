# Modes and Model Routing

## Built-In Modes

| Mode     | Intent                                | Initial primary route |
| -------- | ------------------------------------- | --------------------- |
| `low`    | Precisely scoped changes              | GPT-5.6 Terra         |
| `medium` | Default multi-file work               | GPT-5.6 Luna          |
| `high`   | Difficult and subtle work             | GPT-5.6 Sol           |
| `ultra`  | Architecture and open-ended discovery | Claude Fable 5        |

Each mode owns reasoning, autonomy, budget, tool defaults, and Oracle route. Provider model identifiers are configuration resolved through Baton model registration.

System routes separately cover thread titling, media analysis, image generation, and compaction so product modes do not accidentally change those contracts.

Rika reads typed JSON settings from `~/.config/rika/settings.json` and then `.rika/settings.json`; workspace values override global values. `models` maps stable aliases to a provider and provider model id, while `modes` select aliases. Provider connections may persist a non-secret `baseUrl`, including the Vibe OpenAI-compatible gateway. API keys are never accepted from JSON and remain redacted environment values from `RIKA_MODEL_API_KEY`, with existing provider-specific environment variables retained for compatibility.

## Invariants

- Modes are stable product concepts.
- Provider routing may change without renaming a mode.
- Mode changes apply only when no Turn is active.
- A Turn records the selected mode and resolved routing metadata needed for diagnosis.
- Missing model registration fails typed.
- Legacy mode identifiers are rejected.
- Missing aliases, malformed configuration, and unsupported providers fail typed before runtime initialization.
- CLI and TUI executions consume the same resolved route from the application composition root.
- The TUI mode picker exposes each built-in mode's current route label, marks the active route, and changes it only after explicit confirmation between Turns.

Model registrations opt into mode-derived variants. Production routes resolve reasoning effort and fast mode to exact registration keys. Fixed deterministic fixtures retain their single registered selection regardless of the product mode so packaged and TUI tests exercise the same routing boundary without adding fixture-only aliases or weakening exact registry lookup.

## Extensions

Plugins may register custom modes with unique ids, approved model routes, instructions, tools, and budgets. Built-in modes remain a fixed dial; custom modes use a separate picker.
