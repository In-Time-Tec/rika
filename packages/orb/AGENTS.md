# @rika/orb

This package owns remote sandbox orchestration.

## Rules

- Keep raw E2B SDK usage inside `SandboxClient`.
- Expose Effect services and fake layers through the package entrypoint.
- Preserve sandbox metadata keys `thread_id` and `project_id` on every created sandbox.
- Treat nonzero command exits as data in the exec stream, not service transport failures.
