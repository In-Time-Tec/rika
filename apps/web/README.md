# Rika web

The web service renders Rika's browser identity, Organization onboarding, invitation, device approval, consent, and account pages. It owns no identity or product state. Protected page requests send only the browser `Cookie` header to the API's private `/api/account` route and treat anonymous, unavailable, and Organization-free accounts as explicit outcomes.

Railway selects `/apps/web/railway.json` through this service's Railway Config File setting while leaving its source root directory unset, so its Docker build keeps the shared repository context. Caddy is the only public ingress. Browser JavaScript calls same-origin `/api/*` routes through that proxy. The web service is reachable only through Railway private DNS and exposes `/healthz` for its own Railway health check.

Set `PORT=3000`, `NODE_ENV=production`, `API_DOMAIN` to the API service's private Railway domain, and `API_PORT=3000`. The service needs no PostgreSQL, Better Auth, GitHub, Resend, or E2B credentials.

From the repository root:

```sh
bun --cwd apps/web start
```
