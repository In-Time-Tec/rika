# Rika control plane

The control plane is a Railway-ready Bun service and the composition root for `@rika/identity`. Better Auth owns PostgreSQL identity, session, organization, invitation, OAuth provider, and device authorization state. Rika routes require an organization membership before product access or authorization approval.

The browser surface is server-rendered HTML with one static script and stylesheet. `/healthz` is the Railway liveness endpoint and `/readyz` checks PostgreSQL readiness.

## Configure

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

`migrate` applies the reviewed Better Auth 1.7.1 PostgreSQL migration transactionally under an advisory lock and records it in `control_plane_migration`. It is safe to run before every Railway release.

## Native CLI device authorization

Each CLI installation generates and retains its own DPoP key, then dynamically registers a separate public client:

```text
POST <BETTER_AUTH_URL>/api/auth/oauth2/register
Content-Type: application/json

{
  "client_name": "Rika CLI",
  "application_type": "native",
  "token_endpoint_auth_method": "none",
  "grant_types": [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token"
  ],
  "scope": "openid profile email offline_access account",
  "software_id": "rika-cli",
  "software_version": "<version>",
  "dpop_bound_access_tokens": true,
  "resources": ["<BETTER_AUTH_URL>/api"]
}
```

The installation stores only the returned `client_id`; public clients receive no client secret. It starts authorization at `POST /api/auth/device/code` and polls `POST /api/auth/oauth2/token` with grant type `urn:ietf:params:oauth:grant-type:device_code`. Device-code and refresh-token requests must include an RFC 9449 `DPoP` proof signed by the installation key. Access to `<BETTER_AUTH_URL>/api` is resource-bound and always requires DPoP, independently of client metadata.

Tokens can be revoked at `POST /api/auth/oauth2/revoke` with `client_id`, `token`, and `token_type_hint`. Better Auth 1.7.1 does not issue RFC 7592 registration management credentials, so a public installation cannot delete its dynamically registered client; the identity package reports that operation as explicitly unsupported rather than pretending to call an endpoint.
