# Mode selection

Users choose among the mode names in their effective configuration. The built-in configuration supplies `low`, `medium`, `high`, and `ultra`, but a user-defined `modes` map may replace them with entirely custom names. Clicking the footer mode label, using the mode shortcut, or choosing the command-palette action opens the dynamic selector. It wraps during keyboard navigation, previews the hovered mode's Agent and Oracle routes, and applies a committed selection to later submissions. Escape closes it without changing the active mode.

Selection precedence is explicit and stable:

1. An explicit `--mode` or Turn selection wins.
2. Without an explicit selection, execution uses the configured `defaultMode`.
3. The interactive picker initially highlights the last committed mode only while that name still exists; otherwise it highlights the active mode, which is the explicit mode or configured default.
4. Remembered picker state never overrides execution by itself. A malformed or stale remembered value is ignored.

A valid committed picker selection is remembered in the active Profile for the next picker. The selector accent follows the hovered mode, and a commit retypes the footer label and wipes the context meter into the new mode color. Fast mode remains a separate toggle; the terminal does not offer a direct reasoning-effort override.
