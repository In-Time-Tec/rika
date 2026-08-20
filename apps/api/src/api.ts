import { Context, Effect, Layer, Schema } from "effect"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
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
const ConnectionRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    project_id: Schema.optionalKey(Schema.NonEmptyString),
    placement: Schema.optionalKey(Schema.Literals(["local", "e2b"])),
  }),
)
const ConnectionResponse = Schema.Struct({ threadId: Schema.String }).pipe(HttpApiSchema.status(201))
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
const ThreadId = Schema.String.check(Schema.isPattern(/^(local|e2b)_[A-Za-z0-9_-]+$/))
const OperationKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
)
const OperationRequest = strict(
  Schema.Struct({
    kind: Schema.Literal("run"),
    prompt: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    mode: Schema.optionalKey(Schema.String),
  }),
)
const OperationResponse = Schema.Struct({ output: Schema.String, exitCode: Schema.optionalKey(Schema.Int) })

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
    HttpApiEndpoint.post("createConnection", "/api/v1/connections", {
      payload: ConnectionRequest,
      success: ConnectionResponse,
      error: [Forbidden, NotFound, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("admitLocalExecutor", "/api/v1/threads/:threadId/local-executor-admissions", {
      params: { threadId: ThreadId },
      payload: LocalExecutorAdmissionRequest,
      success: LocalExecutorAdmissionResponse,
      error: [Forbidden, NotFound, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("run", "/api/v1/threads/:threadId/operations", {
      params: { threadId: ThreadId },
      headers: { "idempotency-key": OperationKey },
      payload: OperationRequest,
      success: OperationResponse,
      error: [Forbidden, NotFound, Conflict, Unprocessable, ServiceUnavailable],
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
      createConnection: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          return yield* dependencies.product
            .createConnection({
              principal: authenticatedPrincipal(access),
              owner:
                payload.owner.kind === "personal"
                  ? { _tag: "PersonalOwner", userId: BetterAuthUserId.make(access.principal.userId) }
                  : {
                      _tag: "OrganizationOwner",
                      organizationId: OrganizationId.make(payload.owner.organization_id),
                    },
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              placement: payload.placement ?? "local",
            })
            .pipe(Effect.mapError(() => Forbidden.make({ message: "Connection could not be created" })))
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
      run: ({ headers, params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const run = yield* dependencies.product
            .admitRun({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              operationKey: headers["idempotency-key"],
              prompt: payload.prompt.join("\n"),
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "conflict") return Conflict.make({ message: "Operation identity conflicts" })
                if (error.kind === "not-found") return NotFound.make({ message: "Thread is unavailable" })
                if (error.kind === "forbidden") return Forbidden.make({ message: "Operation was not admitted" })
                return ServiceUnavailable.make({ message: "Product service unavailable" })
              }),
            )
          let response = run.previous
          if (response === undefined) {
            const result = yield* dependencies.executor
              .run({ threadId: params.threadId, operationKey: run.operationKey, code: run.prompt })
              .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Executor is unavailable" })))
            if (!result.eventPersisted) {
              if (result.access === undefined)
                return yield* ServiceUnavailable.make({ message: "Executor result has no completion authority" })
              yield* dependencies.product
                .completeRun({ run, access: result.access, response: result.response })
                .pipe(
                  Effect.mapError(() =>
                    ServiceUnavailable.make({ message: "Operation result could not be persisted" }),
                  ),
                )
            }
            response = result.response
          }
          if (response._tag === "Suspend")
            return yield* ServiceUnavailable.make({ message: "Executor operation suspended" })
          if (response._tag === "DomainFailure") {
            const failureValue = response.failure as Record<string, unknown>
            const stdout = typeof failureValue.stdout === "string" ? failureValue.stdout : ""
            const stderr = typeof failureValue.stderr === "string" ? failureValue.stderr : ""
            const exitCode = typeof failureValue.exitCode === "number" ? failureValue.exitCode : undefined
            return { output: `${stdout}${stderr}`, ...(exitCode === undefined ? {} : { exitCode }) }
          }
          const value = response.result
          if (typeof value !== "object" || value === null || Array.isArray(value))
            return yield* ServiceUnavailable.make({ message: "Executor returned an invalid result" })
          const output = value as Record<string, unknown>
          const stdout = typeof output.stdout === "string" ? output.stdout : ""
          const stderr = typeof output.stderr === "string" ? output.stderr : ""
          const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined
          return { output: `${stdout}${stderr}`, ...(exitCode === undefined ? {} : { exitCode }) }
        }),
    }),
  )

export const isRikaApiPath = (pathname: string) =>
  pathname === "/healthz" ||
  pathname === "/readyz" ||
  pathname === "/api/v1/auth/cli/devices/revoke-all" ||
  pathname === "/api/v1/me/context" ||
  pathname === "/api/v1/connections" ||
  /^\/api\/v1\/threads\/[^/]+\/(operations|local-executor-admissions)$/.test(pathname)

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
