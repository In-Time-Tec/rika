# Rika proxy

This is the only public Railway service. Production and pull-request environments select `/apps/proxy/railway.json`; personal `bun run dev:remote` projects declare the equivalent Docker, health, and generated-domain settings in `alchemy.run.ts`. Both keep Docker paths relative to the repository root. The proxy resolves the API and web Railway private DNS names for each upstream selection. It handles `/_healthz` itself, sends the executor WebSocket and API routes to the API, and sends all other paths to web.

Required environment values are `PORT`, `API_DOMAIN`, `API_PORT`, `WEB_DOMAIN`, and `WEB_PORT`. `API_DOMAIN` and `WEB_DOMAIN` must be Railway private DNS names. The entrypoint rejects an incomplete configuration. Caddy preserves request paths and WebSocket upgrades. Upstream retries are disabled. Private-DNS selection is IPv4-only because both Bun services listen on `0.0.0.0`.
