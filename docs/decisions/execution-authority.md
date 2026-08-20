# Execution authority

Railway's Rika API is the only production product service, with PostgreSQL the only durable authority for Hosted Owners, Projects, Threads, Turns, commands, queues, transcripts, approvals, projections, assignments, and lifecycle state. TenetKit's PostgreSQL runtime is the only authority for Runs, model steps, compaction, tool operations, retries, and terminal outcomes, and Railway alone performs model-provider calls and holds those credentials.

Executors own only machine-bound filesystem, shell, Git, process, PTY, kernel, and tool effects while holding a current fenced assignment. A TUI renders durable state and sends controls; it owns no product, execution, or side-effect authority. Neither role may create a parallel local production ledger or agent loop. This split gives restarts, disconnects, children, waits, joins, cancellation, and unknown outcomes one recovery story.
