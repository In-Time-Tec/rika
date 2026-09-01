# Diagnostics

The Runner stream covers transport lifecycle and reconnects, durable native tool admission and settlement, machine dispatch and cancellation, and Executor fencing. Diagnostics identify Accepted, Started, Output, Terminal, `MachineExecute`, `MachineCancel`, and `MachineResult` transitions with opaque operation, tool-call, assignment, and machine identifiers.

Diagnostics never contain prompts, commands, file content, tool output, provider payloads, or credentials. A stalled operation therefore leaves only safe lifecycle evidence: last durable frame, reconnect or replay decision, cancellation state, deadline, and terminal outcome. Ambiguous unsafe execution is recorded as unknown rather than rewritten as success or replayed blindly.
