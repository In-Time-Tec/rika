# Editor path links

Workspace-relative file targets in transcript and sidebar views can include a line and column and render as clickable terminal text. Activating one opens the configured editor at that location, or the platform default application when no editor is configured.

Rika rejects targets outside the Workspace. It suspends terminal rendering while the editor is active and resumes the terminal afterward.
