# Rika Server

Rika Server is the hosted control plane. Stateless Bun and Effect replicas serve HTTPS, authenticated client WebSockets, and authenticated executor WebSockets. PostgreSQL owns product state and Baton's runtime state; replicas coordinate queue admission, model execution, executor assignments, projections, E2B lifecycle, and durable delivery through transactions and leases.

Local-device and E2B Executors connect outbound and expose only their assigned Workspace capability. They own files, kernels, coding tools, processes, and PTYs while their current generation and lease remain valid. They never open PostgreSQL, admit a Baton Run, or become a fallback Server. Clients own presentation and local selection only; disconnecting one does not stop shared work.
