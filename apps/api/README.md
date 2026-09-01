# Rika API

The API is a Railway-ready Bun service and the composition root for `@rika/identity`. Better Auth owns PostgreSQL identity, session, organization, invitation, OAuth provider, and device authorization state. Every authenticated user has a personal hosted owner; organization membership is optional.

The API owns no browser pages. The separate `@rika/web` service renders those pages, and the public Caddy proxy keeps browser and API traffic on one origin. `/healthz` is liveness and `/readyz` checks PostgreSQL and the services required to admit work.

## Deploy to Railway

Production and pull-request environments select `/apps/api/railway.json` through this service's Railway Config File setting while leaving its source root directory unset. Personal `bun run dev:remote` projects declare the equivalent settings in `alchemy.run.ts` and upload the current repository-root Docker context. Both paths build `apps/api/Dockerfile`, run `migrate` only for this service, and promote a release after `GET /readyz` succeeds. The configured overlap keeps the healthy release serving while its replacement becomes ready and then drains the old process after `SIGTERM`.

Railway terminates public TLS at the proxy edge. Caddy forwards API traffic over private DNS. At the Bun adapter boundary, the API reconstructs the request URL from the configured public proxy origin rather than trusting `Host` or `X-Forwarded-*`. This keeps DPoP `htu`, dynamic-registration resources, and Better Auth callbacks on one canonical HTTPS origin.

Set these API service variables in Railway. `PORT=3000` is also the private port configured in the proxy.

- `NODE_ENV=production`
- `DATABASE_URL`: reference the attached Railway PostgreSQL service's private connection URL.
- `DATABASE_SSL`: `disable` for that trusted private network, or `verify-full` when using a publicly trusted PostgreSQL certificate.
- `BETTER_AUTH_URL`: the public HTTPS proxy origin.
- `BETTER_AUTH_SECRET`: a unique value with at least 32 high-entropy characters and 16 distinct characters.
- `BETTER_AUTH_TRUSTED_ORIGINS`: comma-separated HTTPS browser origins, including `BETTER_AUTH_URL`.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: OAuth application credentials.
- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`: the repository GitHub App's numeric ID and PKCS#8 private key.
- `RESEND_API_KEY` and `EMAIL_FROM`: an authorized Resend API key and sender.
- `E2B_API_KEY`: the API-only E2B provider key.
- `E2B_APP_ID` and `E2B_DEPLOYMENT_ID`: stable ownership labels for managed sandbox inventory.
- `E2B_TEMPLATE_ID`: the commit-qualified E2B template ID.
- `E2B_TEMPLATE_BUILD_ID`: the successful build receipt UUID; creation pins `<template-id>:<build-id>` and also uses it for assignment identity and fencing.
- `RIKA_EXECUTOR_API_URL`: the public proxy `wss://` origin with `/api/v1/executors`.
- `RIKA_WORKSPACE_CHECKPOINT_BUCKET`, `RIKA_WORKSPACE_CHECKPOINT_REGION`, and `RIKA_WORKSPACE_CHECKPOINT_ENDPOINT`: references to a Railway Storage Bucket's `BUCKET`, `REGION`, and `ENDPOINT` variables.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: references to that bucket's `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY` variables for the AWS SDK credential chain.
- `RIKA_WORKSPACE_ENCRYPTION_KEY`: a base64-encoded 32-byte key generated once for encrypting Workspace checkpoints. Keep the same key while stored checkpoints must remain recoverable.
- `RIKA_WORKSPACE_SETUP_CACHE`: `true` to reuse encrypted setup archives from the checkpoint bucket, otherwise `false`.
- `RIKA_PROVIDER_CREDENTIAL_KEY`: a base64-encoded 32-byte key generated once for encrypting model-provider credentials.
- `RIKA_PROXY_PUBLIC_DOMAIN`: a reference to the proxy service's Railway public domain. Non-production Railway environments derive their callback, trusted-origin, resource, and executor URLs from this value.

Keep all credentials in Railway variables. Do not put them in the repository, Docker build arguments, or image files.

## Configure locally

Copy the repository-root `.env.example` into the deployment environment. `BETTER_AUTH_URL` and every comma-separated `BETTER_AUTH_TRUSTED_ORIGINS` entry must be HTTPS origins in production. Generate `BETTER_AUTH_SECRET` with at least 32 high-entropy characters and 16 distinct characters.

Set `DATABASE_SSL=verify-full` when PostgreSQL presents a certificate chaining to a trusted CA, `require` only when the provider encrypts with a private CA, or `disable` only on a trusted private Railway network.

The GitHub OAuth callback is `<BETTER_AUTH_URL>/api/auth/callback/github`. Resend must authorize the sender in `EMAIL_FROM`.

## Migrate and run

From the repository root:

```sh
bun install
bun --cwd apps/api run migrate
bun --cwd apps/api run start
```

`migrate` applies the reviewed identity and hosted-product PostgreSQL migrations transactionally under an advisory lock, records them in `rika_api_migration`, and then applies the Generalist PostgreSQL schema. It is safe to run before every Railway release.

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

The API validates this request, dynamically registers the native public OAuth client, and atomically records the installation binding. The installation stores only the returned `client_id`; public clients receive no client secret. It starts authorization at `POST /api/auth/device/code` and polls `POST /api/auth/oauth2/token` with grant type `urn:ietf:params:oauth:grant-type:device_code`. Device-code and refresh-token requests must include an RFC 9449 `DPoP` proof signed by the installation key. Access to `<BETTER_AUTH_URL>/api/v1` is resource-bound and always requires DPoP, independently of client metadata.

Tokens can be revoked at `POST /api/auth/oauth2/revoke` with `client_id`, `token`, and `token_type_hint`. Better Auth 1.7.1 does not issue RFC 7592 registration management credentials, so a public installation cannot delete its dynamically registered client; the identity package reports that operation as explicitly unsupported rather than pretending to call an endpoint.
