import { Effect, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import { RikaApi } from "../contract"
import { CliRegistrationResponse } from "./routes"
import {
  BadRequest,
  CurrentAccess,
  NotFound,
  Unauthorized,
  ServiceUnavailable,
  authenticatedPrincipal,
  hostedOwner,
  projectFailure,
} from "../access"

const request = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap(HttpServerRequest.toWeb),
  Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
)
const responseJson = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: () => ServiceUnavailable.make({ message: "Identity service returned an invalid response" }),
  })
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const publicIdentityHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "publicIdentity", (handlers) =>
    handlers.handle("registerCli", ({ payload }) =>
      Effect.gen(function* () {
        const incoming = yield* request
        const expectedResource = `${new URL(incoming.url).origin}/api/v1`
        if (payload.resource !== expectedResource) return yield* BadRequest.make({ message: "Invalid OAuth resource" })
        const delegated = yield* dependencies.identity
          .handle(
            new Request(`${new URL(incoming.url).origin}/api/auth/oauth2/register`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: encodeJson({
                client_name: "Rika CLI",
                application_type: "native",
                token_endpoint_auth_method: "none",
                grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
                scope: "openid profile email offline_access account",
                software_id: "rika-cli",
                dpop_bound_access_tokens: true,
                resources: [expectedResource],
              }),
            }),
          )
          .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Identity service unavailable" })))
        if (!delegated.ok) return yield* BadRequest.make({ message: "CLI registration was rejected" })
        const registration = yield* responseJson(delegated).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CliRegistrationResponse)),
          Effect.mapError(() =>
            ServiceUnavailable.make({ message: "Identity service returned an invalid registration" }),
          ),
        )
        const stored = yield* dependencies.devices
          .register({
            clientId: registration.client_id,
            deviceId: payload.reference_id.slice("cli-device:".length),
            publicJwk: payload.jwk,
            jwkThumbprint: payload.dpop_jkt,
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        if (!stored) {
          yield* dependencies.devices.discard(registration.client_id).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("cli-device-registration.discard-failed").pipe(
                Effect.annotateLogs("rika.error.cause", String(cause)),
              ),
            ),
            Effect.ignore,
          )
          return yield* ServiceUnavailable.make({ message: "CLI registration could not be persisted" })
        }
        return registration
      }),
    ),
  )

export const identityHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "identity", (handlers) =>
    handlers.handleAll({
      account: () => Effect.map(CurrentAccess, (access) => access.account),
      listDevices: () =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          const devices = yield* dependencies.devices
            .list(access.principal)
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Identity service unavailable" })))
          return { devices }
        }),
      revokeDevice: ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          const revoked = yield* dependencies.devices
            .revoke(access.principal, params.deviceId)
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Identity service unavailable" })))
          if (!revoked) return yield* NotFound.make({ message: "CLI device was not found" })
        }),
      revokeAllDevices: () =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          yield* dependencies.devices
            .revokeAll(access.principal)
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "CLI device revocation failed" })))
        }),
      context: () =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const projects = yield* dependencies.product
            .projects(authenticatedPrincipal(access))
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Product service unavailable" })))
          return {
            account: {
              id: access.account.user.id,
              email: access.account.user.email,
              name: access.account.user.name,
            },
            organizations: access.account.memberships.map((membership) => membership.organization),
            projects: projects.map((project) => ({
              id: project.id,
              ownerId: project.ownerId,
              owner:
                project.owner._tag === "PersonalOwner"
                  ? { kind: "personal" as const, userId: project.owner.userId }
                  : { kind: "organization" as const, organizationId: project.owner.organizationId },
              name: project.name,
              slug: project.name
                .toLowerCase()
                .replaceAll(/[^a-z0-9]+/g, "-")
                .replaceAll(/^-|-$/g, ""),
            })),
          }
        }),
      createProject: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const project = yield* dependencies.product
            .createProject({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              name: payload.name,
            })
            .pipe(Effect.mapError(projectFailure))
          return {
            id: project.id,
            ownerId: project.ownerId,
            owner:
              project.owner._tag === "PersonalOwner"
                ? { kind: "personal" as const, userId: project.owner.userId }
                : { kind: "organization" as const, organizationId: project.owner.organizationId },
            name: project.name,
            slug: project.name
              .toLowerCase()
              .replaceAll(/[^a-z0-9]+/g, "-")
              .replaceAll(/^-|-$/g, ""),
          }
        }),
      inviteMember: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          const membership = access.account.memberships.find(
            (candidate) => candidate.organization.id === params.organizationId,
          )
          if (membership === undefined) return yield* NotFound.make({ message: "Organization is unavailable" })
          const incoming = yield* request
          const delegated = yield* dependencies.identity
            .handle(
              new Request(`${new URL(incoming.url).origin}/api/auth/organization/invite-member`, {
                method: "POST",
                headers: incoming.headers,
                body: encodeJson({
                  email: payload.email,
                  organizationId: membership.organization.id,
                  role: "member",
                }),
              }),
            )
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Identity service unavailable" })))
          if (!delegated.ok) return yield* BadRequest.make({ message: "Organization invitation was rejected" })
          return yield* responseJson(delegated)
        }),
    }),
  )
