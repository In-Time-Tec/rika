# Rika Server

Rika Server is the hosted API. Stateless Bun and Effect replicas serve HTTPS, authenticated multi-client Thread WebSockets, and authenticated Executor WebSockets. PostgreSQL owns product state and Generalist Runtime state; replicas coordinate command admission, model execution, Executor assignments, projections, Orb lifecycle, portals, and durable delivery through transactions and leases.

Runner and Orb Executors connect outbound and expose only their assigned Workspace capability. They own files, kernels, coding tools, services, and processes while their current generation and lease remain valid. The FoldKit web app and OpenTUI client consume the same snapshots, events, presence, and lifecycle commands. Executors never open PostgreSQL, admit a Generalist Run, or become a fallback Server; disconnecting a client never stops shared work.
