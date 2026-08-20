# Rika control plane

The control plane is a Railway-ready Bun service and the composition root for `@rika/identity`. Better Auth owns PostgreSQL identity, session, organization, invitation, OAuth provider, and device authorization state. Rika routes require an organization membership before product access or authorization approval.

The browser surface is server-rendered HTML with one static script and stylesheet. `/healthz` is the Railway liveness endpoint and `/readyz` checks PostgreSQL readiness.

## Deploy to Railway

Railway builds the root `Dockerfile`, runs `migrate` as the pre-deploy command, and only promotes a release after `GET /readyz` can reach PostgreSQL. The configured 30-second overlap keeps the healthy release serving while its replacement becomes ready; Railway then gives the old release 30 seconds to drain after `SIGTERM`.

Railway terminates public TLS before forwarding plain HTTP to Bun. At the adapter boundary, the control plane reconstructs the request URL from the configured `BETTER_AUTH_URL` plus the incoming path and query. It does not trust `Host` or `X-Forwarded-*` to choose the OAuth resource origin. This keeps DPoP `htu`, dynamic-registration resources, and Better Auth callbacks on the canonical public HTTPS origin.

Set these service variables in Railway. Railway supplies `PORT`; do not replace it with a fixed production value.

- `NODE_ENV=production`
- `DATABASE_URL`: reference the attached Railway PostgreSQL service's private connection URL.
- `DATABASE_SSL`: `disable` for that trusted private network, or `verify-full` when using a publicly trusted PostgreSQL certificate.
- `BETTER_AUTH_URL`: the public HTTPS origin for this service.
- `BETTER_AUTH_SECRET`: a unique value with at least 32 high-entropy characters and 16 distinct characters.
- `BETTER_AUTH_TRUSTED_ORIGINS`: comma-separated HTTPS browser origins, including `BETTER_AUTH_URL`.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: OAuth application credentials.
- `RESEND_API_KEY` and `EMAIL_FROM`: an authorized Resend API key and sender.
- `E2B_API_KEY`: the controller-only E2B API key.
- `E2B_APP_ID` and `E2B_DEPLOYMENT_ID`: stable ownership labels for managed sandbox inventory.
- `E2B_TEMPLATE_ID`: the commit-qualified E2B template ID accepted by `Sandbox.create`.
- `E2B_TEMPLATE_BUILD_ID`: the successful build receipt UUID used for assignment identity and fencing.
- `RIKA_EXECUTOR_CONTROLLER_URL`: this service's public `wss://` origin with `/api/v1/executors`.

Keep all credentials in Railway variables. Do not put them in the repository, Docker build arguments, or image files.

## Configure locally

Copy `.env.example` into the deployment environment. `BETTER_AUTH_URL` and every comma-separated `BETTER_AUTH_TRUSTED_ORIGINS` entry must be HTTPS origins in production. Generate `BETTER_AUTH_SECRET` with at least 32 high-entropy characters and 16 distinct characters.

Set `DATABASE_SSL=verify-full` when PostgreSQL presents a certificate chaining to a trusted CA, `require` only when the provider encrypts with a private CA, or `disable` only on a trusted private Railway network.

The GitHub OAuth callback is `<BETTER_AUTH_URL>/api/auth/callback/github`. Resend must authorize the sender in `EMAIL_FROM`.

## Migrate and run

From the repository root:

```sh
bun install
bun --cwd apps/control-plane run migrate
bun --cwd apps/control-plane run start
```

`migrate` applies the reviewed identity and hosted-product PostgreSQL migrations transactionally under an advisory lock, records them in `control_plane_migration`, and then applies the TenetKit PostgreSQL schema. It is safe to run before every Railway release.

## Native CLI device authorization

Each CLI installation generates and retains its own DPoP key, then dynamically registers a separate public client:

```text
POST <BETTER_AUTH_URL>/api/v1/auth/cli/registrations
Content-Type: application/json

{
  "reference_id": "cli-device:<installation UUID>",
  "token_endpoint_auth_method": "none",
  "grant_types": [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token"
  ],
  "scope": "openid profile email offline_access account",
  "resource": "<BETTER_AUTH_URL>/api/v1",
  "dpop_jkt": "<P-256 JWK thumbprint>",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "<base64url x coordinate>",
    "y": "<base64url y coordinate>"
  }
}
```

The control plane validates this request, dynamically registers the native public OAuth client, and atomically records the installation binding. The installation stores only the returned `client_id`; public clients receive no client secret. It starts authorization at `POST /api/auth/device/code` and polls `POST /api/auth/oauth2/token` with grant type `urn:ietf:params:oauth:grant-type:device_code`. Device-code and refresh-token requests must include an RFC 9449 `DPoP` proof signed by the installation key. Access to `<BETTER_AUTH_URL>/api/v1` is resource-bound and always requires DPoP, independently of client metadata.

Tokens can be revoked at `POST /api/auth/oauth2/revoke` with `client_id`, `token`, and `token_type_hint`. Better Auth 1.7.1 does not issue RFC 7592 registration management credentials, so a public installation cannot delete its dynamically registered client; the identity package reports that operation as explicitly unsupported rather than pretending to call an endpoint.
