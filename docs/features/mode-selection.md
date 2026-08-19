# Mode selection

Users choose among the mode names in their effective configuration. The built-in configuration supplies `low`, `medium`, `high`, and `ultra`, but a user-defined `modes` map may replace them with entirely custom names. Clicking the footer mode label, using the mode shortcut, or choosing the command-palette action opens the dynamic selector. It wraps during keyboard navigation, previews the hovered mode's Agent and Oracle routes, and applies a committed selection to later submissions. Escape closes it without changing the active mode.

Selection precedence is explicit and stable:

1. An explicit `--mode` or Turn selection wins.
2. Without an explicit selection, a configured `defaultMode` controls execution.
3. When `defaultMode` is omitted, the last committed remembered mode controls later Turns and survives process restarts while that mode still exists.
4. Missing, stale, or malformed remembered state falls back to the effective configuration default, which is `medium` for the built-in configuration.
5. The interactive picker initially highlights the last committed mode while that name still exists; otherwise it highlights the active mode. A remembered picker value never overrides a configured `defaultMode` until the user commits that mode for later submissions.

A valid committed picker selection is remembered in the active Profile for later execution and picker startup when `defaultMode` is omitted, or only for picker startup when `defaultMode` is configured. The selector accent follows the hovered mode, and a commit retypes the footer label and wipes the context meter into the new mode color. Fast mode remains a separate toggle; the terminal does not offer a direct reasoning-effort override.
