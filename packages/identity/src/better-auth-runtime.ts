import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider"
import { betterAuth, type BetterAuthPlugin } from "better-auth"
import { jwt, organization } from "better-auth/plugins"
import { Effect, Redacted, Schema } from "effect"
import type { Pool } from "pg"
import type { IdentityConfig } from "./config"
import { invitationEmail, passwordResetEmail, verificationEmail, type MailSender } from "./mail"

export class IdentityRuntimeError extends Schema.TaggedError<IdentityRuntimeError>()("IdentityRuntimeError", {
  kind: Schema.Literals(["invalid", "unavailable"]),
}) {}

export interface IdentityPrincipal {
  readonly userId: string
  readonly clientId?: string
  readonly dpopJkt?: string
}

export interface IdentityRuntime {
  readonly handle: (request: Request) => Effect.Effect<Response, IdentityRuntimeError>
  readonly identify: (request: Request) => Effect.Effect<IdentityPrincipal | undefined, IdentityRuntimeError>
  readonly protectedResourceMetadata: Effect.Effect<object, IdentityRuntimeError>
}

const snakeCase = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()

const snakeCaseFields = (fields: ReadonlyArray<string>) =>
  Object.fromEntries(fields.map((field) => [field, snakeCase(field)]))

export const identityOAuthResourceContract = (config: Pick<IdentityConfig, "baseUrl" | "resource">) => ({
  resource: config.resource,
  issuer: `${config.baseUrl}/api/auth`,
  jwksUrl: `${config.baseUrl}/api/auth/jwks`,
})

const snakeCasePlugin = (plugin: BetterAuthPlugin): BetterAuthPlugin => {
  if (plugin.schema === undefined) return plugin
  return {
    ...plugin,
    schema: Object.fromEntries(
      Object.entries(plugin.schema).map(([model, table]) => [
        model,
        {
          ...table,
          modelName: snakeCase(table.modelName ?? model),
          fields: Object.fromEntries(
            Object.entries(table.fields).map(([field, attributes]) => [
              field,
              { ...attributes, fieldName: snakeCase(attributes.fieldName ?? field) },
            ]),
          ),
        },
      ]),
    ),
  }
}

export const makeBetterAuthIdentityRuntime = (input: {
  readonly config: IdentityConfig
  readonly pool: Pool
  readonly mail: MailSender
}): IdentityRuntime => {
  const { config, mail, pool } = input
  const oauthResource = identityOAuthResourceContract(config)
  const sendMail = (message: Parameters<MailSender["send"]>[0]) => Effect.runPromise(mail.send(message))
  const provider = oauthProvider({
    loginPage: "/login",
    consentPage: "/consent",
    signup: { page: "/signup" },
    scopes: ["openid", "profile", "email", "offline_access", "account"],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: ["openid", "profile", "email", "offline_access", "account"],
    resources: [
      {
        identifier: config.resource,
        allowedScopes: ["account"],
        accessTokenTtl: 900,
        dpopBoundAccessTokensRequired: true,
      },
    ],
    clientRegistrationDefaultResources: [config.resource],
    clientRegistrationAllowedResources: [config.resource],
    enforcePerClientResources: true,
    accessTokenExpiresIn: 900,
    refreshTokenExpiresIn: 2_592_000,
    refreshTokenReuseInterval: 10,
    rateLimit: {
      register: { window: 60, max: 5 },
    },
    prefix: {
      opaqueAccessToken: "rika_at_",
      refreshToken: "rika_rt_",
      clientSecret: "rika_cs_",
    },
  }) as unknown as BetterAuthPlugin
  const auth = betterAuth({
    appName: "Rika",
    baseURL: config.baseUrl,
    secret: Redacted.value(config.authSecret),
    database: pool,
    trustedOrigins: [...config.trustedOrigins],
    user: { fields: snakeCaseFields(["emailVerified", "createdAt", "updatedAt"]) },
    session: {
      fields: snakeCaseFields(["expiresAt", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"]),
    },
    account: {
      fields: snakeCaseFields([
        "accountId",
        "providerId",
        "userId",
        "accessToken",
        "refreshToken",
        "idToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt",
        "createdAt",
        "updatedAt",
      ]),
    },
    verification: { fields: snakeCaseFields(["expiresAt", "createdAt", "updatedAt"]) },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      sendResetPassword: ({ user, url }) => sendMail(passwordResetEmail({ to: user.email, url })),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, token, url }) => {
        const verificationUrl = new URL("/verify-email", config.baseUrl)
        verificationUrl.searchParams.set("token", token)
        const callbackURL = new URL(url).searchParams.get("callbackURL")
        if (callbackURL !== null) verificationUrl.searchParams.set("callbackURL", callbackURL)
        return sendMail(verificationEmail({ to: user.email, url: verificationUrl.href }))
      },
    },
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: Redacted.value(config.githubClientSecret),
      },
    },
    advanced: {
      useSecureCookies: config.production,
    },
    plugins: [
      snakeCasePlugin(
        organization({
          creatorRole: "owner",
          requireEmailVerificationOnInvitation: true,
          sendInvitationEmail: (data) =>
            sendMail(
              invitationEmail({
                to: data.email,
                inviter: data.inviter.user.name,
                organization: data.organization.name,
                url: `${config.baseUrl}/invitations/${encodeURIComponent(data.id)}`,
              }),
            ),
        }),
      ),
      snakeCasePlugin(jwt()),
      snakeCasePlugin(provider),
      snakeCasePlugin(
        oauthDeviceAuthorization({
          verificationUri: `${config.baseUrl}/device`,
          expiresIn: "10m",
          interval: "5s",
        }),
      ),
    ],
  })
  const resource = oauthProviderResourceClient(auth).getActions()
  return {
    handle: Effect.fn("BetterAuthRuntime.handle")((request) =>
      Effect.tryPromise({
        try: () => auth.handler(request),
        catch: () => IdentityRuntimeError.make({ kind: "unavailable" }),
      }),
    ),
    identify: Effect.fn("BetterAuthRuntime.identify")((request) => {
      const authorization = request.headers.get("authorization")
      if (authorization !== null) {
        return Effect.tryPromise({
          try: () =>
            resource
              .verifyAccessTokenRequest(request, {
                verifyOptions: { audience: oauthResource.resource, issuer: oauthResource.issuer },
                requiredScopes: ["account"],
                jwksUrl: oauthResource.jwksUrl,
              })
              .then((payload) => {
                if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new TypeError("missing subject")
                const clientId = typeof payload.client_id === "string" ? payload.client_id : undefined
                const confirmation = payload.cnf
                const dpopJkt =
                  typeof confirmation === "object" &&
                  confirmation !== null &&
                  "jkt" in confirmation &&
                  typeof confirmation.jkt === "string"
                    ? confirmation.jkt
                    : undefined
                return {
                  userId: payload.sub,
                  ...(clientId === undefined ? {} : { clientId }),
                  ...(dpopJkt === undefined ? {} : { dpopJkt }),
                }
              }),
          catch: () => IdentityRuntimeError.make({ kind: "invalid" }),
        })
      }
      return Effect.tryPromise({
        try: () =>
          auth.api
            .getSession({ headers: request.headers })
            .then((session) => (session === null ? undefined : { userId: session.user.id })),
        catch: () => IdentityRuntimeError.make({ kind: "unavailable" }),
      })
    }),
    protectedResourceMetadata: Effect.tryPromise({
      try: () =>
        resource.getProtectedResourceMetadata({
          resource: oauthResource.resource,
          authorization_servers: [oauthResource.issuer],
          scopes_supported: ["account"],
          dpop_bound_access_tokens_required: true,
        }),
      catch: () => IdentityRuntimeError.make({ kind: "unavailable" }),
    }),
  }
}
