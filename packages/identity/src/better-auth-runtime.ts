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

export interface IdentityRuntime {
  readonly handle: (request: Request) => Effect.Effect<Response, IdentityRuntimeError>
  readonly identify: (request: Request) => Effect.Effect<string | undefined, IdentityRuntimeError>
  readonly protectedResourceMetadata: Effect.Effect<object, IdentityRuntimeError>
}

export const makeBetterAuthIdentityRuntime = (input: {
  readonly config: IdentityConfig
  readonly pool: Pool
  readonly mail: MailSender
}): IdentityRuntime => {
  const { config, mail, pool } = input
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
      database: {
        generateId: "uuid",
      },
    },
    plugins: [
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
      jwt(),
      provider,
      oauthDeviceAuthorization({
        verificationUri: `${config.baseUrl}/device`,
        expiresIn: "10m",
        interval: "5s",
      }),
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
                verifyOptions: { audience: config.resource },
                requiredScopes: ["account"],
              })
              .then((payload) => {
                if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new TypeError("missing subject")
                return payload.sub
              }),
          catch: () => IdentityRuntimeError.make({ kind: "invalid" }),
        })
      }
      return Effect.tryPromise({
        try: () => auth.api.getSession({ headers: request.headers }).then((session) => session?.user.id),
        catch: () => IdentityRuntimeError.make({ kind: "unavailable" }),
      })
    }),
    protectedResourceMetadata: Effect.tryPromise({
      try: () =>
        resource.getProtectedResourceMetadata({
          resource: config.resource,
          scopes_supported: ["account"],
          dpop_bound_access_tokens_required: true,
        }),
      catch: () => IdentityRuntimeError.make({ kind: "unavailable" }),
    }),
  }
}
