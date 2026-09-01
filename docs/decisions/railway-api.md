# Railway hosts the Rika services

Rika runs three application services in each Railway environment. Caddy is the only public ingress. It sends `/api/*`, health/readiness, OAuth metadata, and executor WebSockets to the private Bun and Effect API, and sends browser routes to the private Bun web service. PostgreSQL remains the hosted authority. Production follows `main`; pull requests receive isolated environments containing the complete topology and are removed when their pull requests close.

The split keeps browser rendering out of the API process without changing the same-origin public contract. Better Auth callbacks, DPoP resources, CLI requests, browser requests, and executor WebSockets all use the proxy origin. The API reconstructs that configured public origin rather than trusting forwarded origin headers. Caddy is the only client-IP chain parser and overwrites `X-Rika-Client-IP` with its resolved client address before proxying API traffic. Better Auth trusts only that dedicated header, and Railway private DNS is the only path from proxy to the API.

Railway matches the long-lived HTTP and WebSocket process, managed PostgreSQL, deployment, and preview-environment model without introducing an actor runtime into Generalist's execution ownership. Cloudflare is deferred because its runtime and connection model require another adaptation. Rivet Actors remain excluded because a second durable actor authority would overlap PostgreSQL, executor leases, and Generalist Runs.

## Alchemy ownership

Production and pull-request environments remain Git-connected Railway environments governed by
`apps/*/railway.json`. Personal remote development is separate: `alchemy.run.ts` selects first-class Railway
providers only when invoked through `bun run dev:remote`. It creates a dedicated random `rika-dev-*` project from the
current local Docker context. Alchemy owns that project's primary environment, private PostgreSQL 17 service and
volume, Storage Bucket, three application services, variables, generated proxy domain, deployments, and destroy.
It does not adopt or change the production project.

The personal graph preserves the hosted boundary. `api` and `web` have no generated public domains, PostgreSQL has
no public TCP proxy, and only `proxy` receives a generated `*.up.railway.app` domain. Stable service names provide
`api.railway.internal` and `web.railway.internal`. The API uses the private PostgreSQL reference, runs the existing
migration command as Railway's pre-deploy step, and must pass `/readyz`; web must pass `/healthz`; proxy must pass
`/_healthz`. Existing Dockerfiles and Caddy routing remain the runtime contract.

Personal services run with `NODE_ENV=production`. Alchemy generates the database, Better Auth, provider-credential,
and Workspace encryption secrets and reads Storage Bucket credentials from Railway. GitHub OAuth, GitHub App,
Resend, the E2B API key, and the E2B template identity remain external inputs. Alchemy derives the personal E2B
deployment label from the isolated stage. `RAILWAY_API_TOKEN` is provisioning-only and is
never copied into a service. The generated stage identity at `.alchemy/rika-dev-stage` and the corresponding
`.alchemy/state/Rika/<stage>` state directory are retained across deploy and destroy attempts. Deploy uses Alchemy's
adopt and force controls only within that random stage so interrupted creates and delayed Bucket credentials can be
reconciled. Destroy refuses production, staging, and `pr-*` identities, requires state that attests the matching
Railway Project ID, and deletes only the dedicated Alchemy-owned project graph. `RAILWAY_WORKSPACE_ID` pins project
creation to the intended workspace.
