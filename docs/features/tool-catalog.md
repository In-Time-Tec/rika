# Native tool catalog

The admitted toolkit is a closed, provider-neutral catalog containing exactly `bash`, `edit`, `read`, and `shell_command_status`. Each entry combines the Effect AI tool schema, replay policy, side-effect class, deadline, output bound, and presentation metadata. Agent instructions derive exact input shapes and numeric or tuple bounds from those same schemas, so prompt guidance cannot drift from runtime validation.

Execution owns live implementations. Product owns the contracts. Local and remote routes expose the same catalog, and an unknown name or invalid request fails explicitly.
