# TUI v2 visual references

These are the thirteen unmodified screenshots supplied by Dallen on September 7, 2026.
They are the visual targets for the standalone SolidJS interface, not generated snapshots.
The originals retain their embedded display color profiles. Convert to sRGB before measuring
colors; the application background is `#282c34`, not the raw profile-encoded PNG value.

| Image                                                  | State                                            |
| ------------------------------------------------------ | ------------------------------------------------ |
| [welcome.png](welcome.png)                             | Animated welcome orb and changed-file sidebar    |
| [shortcuts.png](shortcuts.png)                         | Help expanded inside the composer                |
| [context-usage.png](context-usage.png)                 | Context and usage above the composer             |
| [mode.png](mode.png)                                   | Horizontal mode selector, route, and description |
| [command-palette.png](command-palette.png)             | Centered command palette                         |
| [switch-thread-empty.png](switch-thread-empty.png)     | Thread switcher with empty preview               |
| [switch-thread-preview.png](switch-thread-preview.png) | Thread switcher with transcript preview          |
| [workspace-files.png](workspace-files.png)             | Workspace file tree                              |
| [transcript-commands.png](transcript-commands.png)     | Expanded command groups and error output         |
| [transcript-source.png](transcript-source.png)         | Syntax-highlighted, line-numbered source         |
| [file-completion.png](file-completion.png)             | File completion anchored above the composer      |
| [exit.png](exit.png)                                   | Bottom-right exit key banner                     |

## Reproduction

[exit-receipt.png](exit-receipt.png) also defines the compact orb, title, workspace,
and relaunch line printed after returning to the shell. V2 prints a truthful
offline-scenario relaunch instead of a nonfunctional hosted continuation command.

Run `bun run tui-v2 --no-animate` in a true-color terminal. Use a 216-column,
62-row viewport for the reference-scale layout. `--no-animate` holds the orb at
one deterministic frame; the supplied images show different animation phases.

Use `Opt/Alt+T` for the file sidebar, `?` for help, `Ctrl+Y` for context,
`Ctrl+S` for modes, `Ctrl+O` for the palette, `Ctrl+T` for the thread switcher,
`@` for file completion, and `Ctrl+C` for the exit banner. `Esc` closes overlays.
The exit banner accepts `Ctrl+N` to archive the current offline thread and start
another, `Ctrl+E` to archive and quit, and another `Ctrl+C` to quit.

V2 remains an offline demonstration: file lists, model routes, usage, and transcript
content are fixtures, not reads from the user's workspace or a hosted session.
The workspace footer is a fixture too. Archiving only changes the in-memory demo.
The reference shortcut legend includes production features such as prompt history
and `$EDITOR` integration that the standalone demo does not implement.

Compare the terminal content, excluding the macOS terminal tab bar. Font choice,
font rasterization, display scaling, color management, and orb phase must be held
constant for a literal pixel diff. Matching terminal-cell geometry on Linux does
not establish pixel identity with a macOS screenshot.
