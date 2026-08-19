# Railway hosts the control plane

Rika runs one Bun and Effect control plane on Railway with PostgreSQL as its hosted authority. Production follows `main`. Pull requests receive isolated Railway environments derived from production and those environments are removed when their pull requests close.

Railway matches the long-lived HTTP and WebSocket process, managed PostgreSQL, deployment, and preview-environment model without introducing an actor runtime into TenetKit's execution ownership. The control plane remains portable application code rather than a collection of provider-specific actors.

Cloudflare is not the first production target because its runtime and connection model would require a separate adaptation before the hosted authority is proven. Rivet Actors are not part of the design because a second durable actor authority would overlap PostgreSQL, executor leases, and TenetKit Runs.
