# Terminal lifecycle

The OpenTUI renderer is owned by a scope: startup acquires it once, normal exit releases input handlers and renderables, and shutdown restores terminal state. External editor use and terminal suspension pause interactive rendering without discarding the Thread view.

The application inherits the terminal's default transparent background and never paints an application background. Cursor focus and blinking follow the active composer or overlay and stop during teardown.

When idle, `Ctrl+C` opens the lower-right thread-exit menu. `Ctrl+N` archives the current Thread and activates a new one, `Ctrl+E` archives before quitting, a second `Ctrl+C` quits without archiving, and `Esc` dismisses the menu. While work is active, `Ctrl+C` continues to cancel that work instead of opening the menu.
