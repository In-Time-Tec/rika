import { Context, Effect, Layer, Schema } from "effect"
import { BetterAuthUserId, OrganizationId, ThreadId } from "@rika/product/hosted-model"
import { ClientTicketResponse } from "@rika/product/client-protocol"
import {
  CheckoutFingerprint,
  LocalRunnerProfile,
  LocalRunnerPollResult,
  RemoteThreadCreationPreference,
} from "@rika/product/local-runner-registration"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/unstable/httpapi"
import { accountAccess, type AccountAccess, type HttpDependencies } from "./http"
import { HostedModelProvider, HostedProviderCredentialError } from "./hosted-provider-credentials"

const Message = { message: Schema.String }

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", Message, { httpApiStatus: 401 }) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", Message, { httpApiStatus: 403 }) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", Message, { httpApiStatus: 404 }) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", Message, { httpApiStatus: 409 }) {}

export class Unprocessable extends Schema.TaggedError<Unprocessable>()("Unprocessable", Message, {
  httpApiStatus: 422,
}) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()("ServiceUnavailable", Message, {
  httpApiStatus: 503,
}) {}

const Status = Schema.Struct({ status: Schema.String })
const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const WireOwner = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal"), userId: Schema.String })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.String })),
])
const ContextResponse = Schema.Struct({
  account: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
  organizations: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String, logo: Schema.NullOr(Schema.String) }),
  ),
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      ownerId: Schema.String,
      owner: WireOwner,
      name: Schema.String,
      slug: Schema.String,
    }),
  ),
})
const ConnectionOwner = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal") })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organization_id: Schema.NonEmptyString })),
])
const ThreadTicketResponse = ClientTicketResponse.pipe(HttpApiSchema.status(201))
const LocalExecutorAdmissionRequest = strict(
  Schema.Struct({
    workspace_fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
)
const LocalExecutorAdmissionResponse = Schema.Struct({
  admissionId: Schema.String,
  ticket: Schema.String,
  expiresAt: Schema.Finite,
  executorUrl: Schema.String,
  workspaceIdentity: Schema.String,
}).pipe(HttpApiSchema.status(201))
const ModelsResponse = Schema.Struct({ modes: Schema.Array(Schema.String) })
const ProviderCredentialRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    api_key: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
  }),
)
const ProviderCredentialRevokeRequest = strict(Schema.Struct({ owner: ConnectionOwner }))
const ProviderCredentialResponse = Schema.Struct({
  provider: HostedModelProvider,
  state: Schema.Literals(["active", "revoked"]),
  revision: Schema.String,
  credentialIdentity: Schema.String,
})
const ProviderCredentialsResponse = Schema.Struct({ credentials: Schema.Array(ProviderCredentialResponse) })

export class CurrentAccess extends Context.Service<
  CurrentAccess,
  Extract<AccountAccess, { readonly _tag: "account" }>
>()("@rika/api/api/CurrentAccess") {}

export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentAccess; requires: never }
>()("@rika/api/api/Authorization", {
  error: [Unauthorized, ServiceUnavailable],
}) {}

class PublicGroup extends HttpApiGroup.make("public", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", { success: Status }),
  HttpApiEndpoint.get("ready", "/readyz", { success: Status, error: ServiceUnavailable }),
) {}

class ProductGroup extends HttpApiGroup.make("product", { topLevel: true })
  .add(
    HttpApiEndpoint.post("revokeAllDevices", "/api/v1/auth/cli/devices/revoke-all", {
      success: HttpApiSchema.NoContent,
      error: ServiceUnavailable,
    }),
    HttpApiEndpoint.get("context", "/api/v1/me/context", {
      success: ContextResponse,
      error: ServiceUnavailable,
    }),
    HttpApiEndpoint.post("issueThreadTicket", "/api/v1/thread-sessions", {
      success: ThreadTicketResponse,
      error: [Unauthorized, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("admitLocalExecutor", "/api/v1/threads/:threadId/local-executor-admissions", {
      params: { threadId: ThreadId },
      payload: LocalExecutorAdmissionRequest,
      success: LocalExecutorAdmissionResponse,
      error: [Forbidden, NotFound, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("registerLocalRunner", "/api/v1/local-runners/:checkoutFingerprint", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      payload: LocalRunnerProfile,
      success: HttpApiSchema.NoContent,
      error: [Forbidden, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.put(
      "setRemoteThreadCreation",
      "/api/v1/local-runners/:checkoutFingerprint/remote-thread-creation",
      {
        params: { checkoutFingerprint: CheckoutFingerprint },
        payload: RemoteThreadCreationPreference,
        success: HttpApiSchema.NoContent,
        error: [NotFound, Forbidden, ServiceUnavailable],
      },
    ),
    HttpApiEndpoint.post("pollLocalRunner", "/api/v1/local-runners/:checkoutFingerprint/admissions", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      success: LocalRunnerPollResult,
      error: [Forbidden, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.get("models", "/api/v1/models", {
      success: ModelsResponse,
      error: ServiceUnavailable,
    }),
    HttpApiEndpoint.put("putProviderCredential", "/api/v1/provider-credentials/:provider", {
      params: { provider: HostedModelProvider },
      payload: ProviderCredentialRequest,
      success: ProviderCredentialResponse,
      error: [Forbidden, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.delete("revokeProviderCredential", "/api/v1/provider-credentials/:provider", {
      params: { provider: HostedModelProvider },
      payload: ProviderCredentialRevokeRequest,
      success: ProviderCredentialResponse,
      error: [Forbidden, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("listProviderCredentials", "/api/v1/provider-credentials/list", {
      payload: ProviderCredentialRevokeRequest,
      success: ProviderCredentialsResponse,
      error: [Forbidden, Unprocessable, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}

export class RikaApi extends HttpApi.make("rika-api").add(PublicGroup).add(ProductGroup) {}

const authorizationLayer = (dependencies: HttpDependencies) =>
  Layer.succeed(
    Authorization,
    Authorization.of((effect) =>
      Effect.gen(function* () {
        const serverRequest = yield* HttpServerRequest.HttpServerRequest
        const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
          Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
        )
        const access = yield* accountAccess(request, dependencies)
        if (access._tag === "unavailable")
          return yield* ServiceUnavailable.make({ message: "Identity service unavailable" })
        if (access._tag !== "account") return yield* Unauthorized.make({ message: "Authentication required" })
        return yield* Effect.provideService(effect, CurrentAccess, access)
      }),
    ),
  )

const publicHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "public", (handlers) =>
    handlers.handleAll({
      health: () => Effect.succeed({ status: "ok" }),
      ready: () =>
        Effect.all([
          dependencies.directory.ready,
          dependencies.product.ready,
          dependencies.executor.ready,
          dependencies.execution.check,
        ]).pipe(
          Effect.as({ status: "ready" }),
          Effect.mapError(() => ServiceUnavailable.make({ message: "API is unavailable" })),
        ),
    }),
  )

const authenticatedPrincipal = (access: CurrentAccess["Service"]) => ({
  userId: access.principal.userId,
  deviceId: access.deviceId!,
  clientId: access.principal.clientId!,
  ...(access.principal.dpopJkt === undefined ? {} : { dpopJkt: access.principal.dpopJkt }),
})

const providerOwner = (owner: typeof ConnectionOwner.Type, access: CurrentAccess["Service"]) =>
  owner.kind === "personal"
    ? { _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(access.principal.userId) }
    : {
        _tag: "OrganizationOwner" as const,
        organizationId: OrganizationId.make(owner.organization_id),
      }

const providerCredentialFailure = (error: HostedProviderCredentialError) => {
  if (error.kind === "forbidden") return Forbidden.make({ message: "Provider credential operation was rejected" })
  if (error.kind === "invalid" || error.kind === "missing" || error.kind === "revoked") {
    return Unprocessable.make({ message: error.message })
  }
  return ServiceUnavailable.make({ message: "Provider credential service unavailable" })
}

const productHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "product", (handlers) =>
    handlers.handleAll({
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
      issueThreadTicket: () =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.threads === undefined)
            return yield* ServiceUnavailable.make({ message: "Hosted Thread service unavailable" })
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const websocketUrl = new URL("/api/v1/threads/socket", request.url)
          websocketUrl.protocol = "wss:"
          const issued = yield* dependencies.threads
            .issueTicket(authenticatedPrincipal(access))
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Thread ticket issuance failed" })))
          return {
            ...issued,
            websocketUrl: websocketUrl.toString(),
            protocol: "rika.thread.v1" as const,
          }
        }),
      admitLocalExecutor: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const executorUrl = new URL("/api/v1/local-executors", request.url)
          executorUrl.protocol = "wss:"
          return yield* dependencies.executor
            .admitLocal({
              threadId: params.threadId,
              workspaceFingerprint: payload.workspace_fingerprint,
              executorUrl: executorUrl.toString(),
              principal: authenticatedPrincipal(access),
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "assignment-missing") return NotFound.make({ message: "Thread is unavailable" })
                if (error.kind === "assignment-conflict" || error.kind === "fenced")
                  return Conflict.make({ message: "Local executor admission is unavailable" })
                return Forbidden.make({ message: "Local executor admission was rejected" })
              }),
            )
        }),
      registerLocalRunner: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          yield* dependencies.product
            .registerLocalRunner({
              principal: authenticatedPrincipal(access),
              checkoutFingerprint: params.checkoutFingerprint,
              registration: payload,
            })
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Local runner registration failed" })))
        }),
      setRemoteThreadCreation: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          yield* dependencies.product
            .setRemoteThreadCreation({
              principal: authenticatedPrincipal(access),
              checkoutFingerprint: params.checkoutFingerprint,
              preference: payload,
            })
            .pipe(
              Effect.mapError((error) =>
                error.kind === "not-found"
                  ? NotFound.make({ message: error.message })
                  : ServiceUnavailable.make({ message: "Local runner preference failed" }),
              ),
            )
        }),
      pollLocalRunner: ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const principal = authenticatedPrincipal(access)
          const candidate = yield* dependencies.product
            .pollLocalRunner({
              principal,
              checkoutFingerprint: params.checkoutFingerprint,
            })
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Local runner polling failed" })))
          if (candidate === undefined) return { _tag: "Waiting" as const }
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const executorUrl = new URL("/api/v1/local-executors", request.url)
          executorUrl.protocol = "wss:"
          const admission = yield* dependencies.executor
            .admitLocal({
              threadId: candidate.threadId,
              workspaceFingerprint: params.checkoutFingerprint,
              executorUrl: executorUrl.toString(),
              principal,
            })
            .pipe(Effect.mapError(() => Conflict.make({ message: "Local runner admission is unavailable" })))
          return { _tag: "Admitted" as const, ...admission }
        }),
      models: () =>
        dependencies.models === undefined
          ? Effect.fail(ServiceUnavailable.make({ message: "Model registry unavailable" }))
          : Effect.succeed({ modes: [...dependencies.models.modes] }),
      putProviderCredential: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .put({
              principal: authenticatedPrincipal(access),
              owner: providerOwner(payload.owner, access),
              provider: params.provider,
              apiKey: payload.api_key,
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      revokeProviderCredential: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .revoke({
              principal: authenticatedPrincipal(access),
              owner: providerOwner(payload.owner, access),
              provider: params.provider,
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      listProviderCredentials: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          const credentials = yield* dependencies.credentials
            .list({
              principal: authenticatedPrincipal(access),
              owner: providerOwner(payload.owner, access),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
          return { credentials: [...credentials] }
        }),
    }),
  )

export const isRikaApiPath = (pathname: string) =>
  pathname === "/healthz" ||
  pathname === "/readyz" ||
  pathname === "/api/v1/auth/cli/devices/revoke-all" ||
  pathname === "/api/v1/me/context" ||
  pathname === "/api/v1/thread-sessions" ||
  pathname === "/api/v1/models" ||
  pathname === "/api/v1/provider-credentials/list" ||
  /^\/api\/v1\/provider-credentials\/[^/]+$/.test(pathname) ||
  /^\/api\/v1\/local-runners\/[^/]+(?:\/remote-thread-creation|\/admissions)?$/.test(pathname) ||
  /^\/api\/v1\/threads\/[^/]+\/local-executor-admissions$/.test(pathname)

export const makeRikaApiHandler = (dependencies: HttpDependencies) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(RikaApi).pipe(
      Layer.provide(
        Layer.merge(
          publicHandlers(dependencies),
          productHandlers(dependencies).pipe(Layer.provide(authorizationLayer(dependencies))),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
