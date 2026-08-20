# Rika proxy

This is the only public Railway service. Railway selects `/apps/proxy/railway.json` through this service's Railway Config File setting while leaving its source root directory unset, so Docker paths remain relative to the repository root. It resolves the API and web Railway private DNS names for each upstream selection. It handles `/_healthz` itself, sends the executor WebSocket and API routes to the API, and sends all other paths to web.

Required environment values are `PORT`, `API_DOMAIN`, `API_PORT`, `WEB_DOMAIN`, and `WEB_PORT`. `API_DOMAIN` and `WEB_DOMAIN` must be Railway private DNS names. The entrypoint rejects an incomplete configuration. Caddy preserves request paths and WebSocket upgrades. Upstream retries are disabled.
