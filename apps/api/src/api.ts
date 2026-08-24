import { Context, Effect, Layer, Schema } from "effect"
import { BetterAuthUserId, OrganizationId, ThreadId } from "@rika/product/hosted-model"
import { IdentityContext, Project } from "@rika/product/hosted-identity-context"
import { ClientTicketResponse } from "@rika/product/client-protocol"
import {
  CheckoutFingerprint,
  RunnerProfile,
  RunnerPollResult,
  RemoteThreadCreationPreference,
} from "@rika/product/runner-registration"
import {
  EnvironmentClassification,
  EnvironmentPhase,
  EnvironmentScope,
  EnvironmentValueName,
  SourceCommitSha,
} from "@rika/product/environment-policy"
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
import { HostedEnvironmentError } from "./hosted-environment"
import { HostedModelProvider, HostedProviderCredentialError } from "./hosted-provider-credentials"
import { RecoveryOperation, type RecoveryResolution } from "./hosted-recovery"
import { ToolAuditRecord } from "./hosted-tool-policy"

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
const ConnectionOwner = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal") })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organization_id: Schema.NonEmptyString })),
])
const ThreadTicketResponse = ClientTicketResponse.pipe(HttpApiSchema.status(201))
const ProjectCreateRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
)
const ProjectCreateResponse = Project.pipe(HttpApiSchema.status(201))
const RunnerAdmissionRequest = strict(
  Schema.Struct({
    workspace_fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
)
const RunnerAdmissionResponse = Schema.Struct({
  admissionId: Schema.String,
  ticket: Schema.String,
  expiresAt: Schema.Finite,
  executorUrl: Schema.String,
  workspaceIdentity: Schema.String,
}).pipe(HttpApiSchema.status(201))
const OperationKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
)
const RecoveryOperationsResponse = Schema.Struct({ operations: Schema.Array(RecoveryOperation) })
const RecoveryResolutionRequest = strict(
  Schema.Union([
    Schema.Struct({ action: Schema.Literal("retry") }),
    Schema.Struct({ action: Schema.Literal("accept"), value: Schema.Unknown }),
    Schema.Struct({ action: Schema.Literal("abort"), reason: Schema.NonEmptyString }),
  ]),
)
const RepositoryPublicationRequest = strict(
  Schema.Struct({
    commit_sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    target_branch: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    body: Schema.String.check(Schema.isMaxLength(65_536)),
  }),
)
const RepositoryPublicationResponse = Schema.Struct({
  publicationId: Schema.String,
  state: Schema.Literals(["approved", "pushing", "pushed", "completed", "failed", "unknown"]),
  branch: Schema.String,
  ref: Schema.String,
  commitSha: Schema.String,
  targetBranch: Schema.String,
  targetCommitSha: Schema.String,
  targetProtected: Schema.Boolean,
  pushResult: Schema.NullOr(Schema.Unknown),
  pullRequestResult: Schema.NullOr(Schema.Unknown),
})
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
const OpenAiAccountRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    access_token: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
    id_token: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
    refresh_token: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
  }),
)
const OpenAiAccountOwnerRequest = strict(Schema.Struct({ owner: ConnectionOwner }))
const OpenAiAccountResponse = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    state: Schema.Literals(["active", "revoked"]),
    revision: Schema.String,
    credentialIdentity: Schema.String,
    fingerprint: Schema.String,
  }),
])
const ToolAuditListRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  }),
)
const ToolAuditListResponse = Schema.Struct({ records: Schema.Array(ToolAuditRecord) })
const EnvironmentOwnerRequest = {
  owner: ConnectionOwner,
  project_id: Schema.optionalKey(Schema.NonEmptyString),
}
const EnvironmentValueRequest = strict(
  Schema.Struct({
    ...EnvironmentOwnerRequest,
    scope: EnvironmentScope,
    classification: EnvironmentClassification,
    phases: Schema.Array(EnvironmentPhase).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
    value: Schema.Redacted(Schema.NonEmptyString, { disallowJsonEncode: true }),
  }),
)
const EnvironmentRevokeRequest = strict(Schema.Struct({ ...EnvironmentOwnerRequest, scope: EnvironmentScope }))
const EnvironmentReferenceResponse = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  scope: EnvironmentScope,
  scopeId: Schema.String,
  name: EnvironmentValueName,
  classification: EnvironmentClassification,
  phases: Schema.Array(EnvironmentPhase),
  revision: Schema.String,
  valueDigest: Schema.String,
  state: Schema.Literals(["active", "revoked"]),
  updatedByUserId: Schema.String,
  updatedAt: Schema.String,
})
const EnvironmentPolicyRequest = strict(
  Schema.Struct({ ...EnvironmentOwnerRequest, personal_overrides: Schema.Boolean }),
)
const SourceApprovalRequest = strict(
  Schema.Struct({
    ...EnvironmentOwnerRequest,
    source_owner: Schema.NonEmptyString,
    source_commit_sha: SourceCommitSha,
    phase: EnvironmentPhase,
  }),
)
const SourceApprovalResponse = Schema.Struct({
  ownerId: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  sourceOwner: Schema.String,
  sourceCommitSha: SourceCommitSha,
  phase: EnvironmentPhase,
  approvedByUserId: Schema.String,
  approvedAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
})
const EgressRequest = strict(Schema.Struct({ ...EnvironmentOwnerRequest, allow: Schema.Array(Schema.NonEmptyString) }))
const EgressResponse = Schema.Struct({ phase: EnvironmentPhase, allow: Schema.Array(Schema.String) })

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
      success: IdentityContext,
      error: ServiceUnavailable,
    }),
    HttpApiEndpoint.post("createProject", "/api/v1/projects", {
      payload: ProjectCreateRequest,
      success: ProjectCreateResponse,
      error: [Forbidden, Conflict, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("issueThreadTicket", "/api/v1/thread-sessions", {
      success: ThreadTicketResponse,
      error: [Unauthorized, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("admitRunner", "/api/v1/threads/:threadId/runner-admissions", {
      params: { threadId: ThreadId },
      payload: RunnerAdmissionRequest,
      success: RunnerAdmissionResponse,
      error: [Forbidden, NotFound, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("registerRunner", "/api/v1/runners/:checkoutFingerprint", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      payload: RunnerProfile,
      success: HttpApiSchema.NoContent,
      error: [Forbidden, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("setRemoteThreadCreation", "/api/v1/runners/:checkoutFingerprint/remote-thread-creation", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      payload: RemoteThreadCreationPreference,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("pollRunner", "/api/v1/runners/:checkoutFingerprint/admissions", {
      params: { checkoutFingerprint: CheckoutFingerprint },
      success: RunnerPollResult,
      error: [Forbidden, Conflict, ServiceUnavailable],
    }),
    HttpApiEndpoint.get("inspectRecovery", "/api/v1/threads/:threadId/runs/:runId/recovery", {
      params: { threadId: ThreadId, runId: Schema.NonEmptyString },
      success: RecoveryOperationsResponse,
      error: [Forbidden, NotFound, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("resolveRecovery", "/api/v1/threads/:threadId/runs/:runId/recovery/:operationId", {
      params: { threadId: ThreadId, runId: Schema.NonEmptyString, operationId: Schema.NonEmptyString },
      headers: { "idempotency-key": OperationKey },
      payload: RecoveryResolutionRequest,
      success: RecoveryOperation,
      error: [Forbidden, NotFound, Conflict, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("publishRepository", "/api/v1/threads/:threadId/repository-publications", {
      params: { threadId: ThreadId },
      headers: { "idempotency-key": OperationKey },
      payload: RepositoryPublicationRequest,
      success: RepositoryPublicationResponse,
      error: [Forbidden, NotFound, Conflict, Unprocessable, ServiceUnavailable],
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
    HttpApiEndpoint.put("putOpenAiAccount", "/api/v1/provider-accounts/openai", {
      payload: OpenAiAccountRequest,
      success: OpenAiAccountResponse,
      error: [Forbidden, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("getOpenAiAccount", "/api/v1/provider-accounts/openai/status", {
      payload: OpenAiAccountOwnerRequest,
      success: OpenAiAccountResponse,
      error: [Forbidden, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.delete("revokeOpenAiAccount", "/api/v1/provider-accounts/openai", {
      payload: OpenAiAccountOwnerRequest,
      success: OpenAiAccountResponse,
      error: [Forbidden, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("putEnvironment", "/api/v1/environment/:name", {
      params: { name: EnvironmentValueName },
      payload: EnvironmentValueRequest,
      success: EnvironmentReferenceResponse,
      error: [Forbidden, NotFound, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.delete("revokeEnvironment", "/api/v1/environment/:name", {
      params: { name: EnvironmentValueName },
      payload: EnvironmentRevokeRequest,
      success: EnvironmentReferenceResponse,
      error: [Forbidden, NotFound, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("putEnvironmentPolicy", "/api/v1/environment-policy", {
      payload: EnvironmentPolicyRequest,
      success: HttpApiSchema.NoContent,
      error: [Forbidden, NotFound, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("approveEnvironmentSource", "/api/v1/environment-approvals", {
      payload: SourceApprovalRequest,
      success: SourceApprovalResponse,
      error: [Forbidden, NotFound, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.delete("revokeEnvironmentSource", "/api/v1/environment-approvals", {
      payload: SourceApprovalRequest,
      success: SourceApprovalResponse,
      error: [Forbidden, NotFound, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.put("putEgress", "/api/v1/egress/:phase", {
      params: { phase: EnvironmentPhase },
      payload: EgressRequest,
      success: EgressResponse,
      error: [Forbidden, NotFound, Unprocessable, ServiceUnavailable],
    }),
    HttpApiEndpoint.post("listToolAudit", "/api/v1/tool-audit-records/list", {
      payload: ToolAuditListRequest,
      success: ToolAuditListResponse,
      error: [Forbidden, ServiceUnavailable],
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
        dependencies.execution.status.pipe(
          Effect.tap((status) => Effect.logInfo("hosted-workers.status", status)),
          Effect.andThen(
            Effect.all([
              dependencies.directory.ready,
              dependencies.product.ready,
              dependencies.executor.ready,
              dependencies.execution.check,
            ]),
          ),
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

const hostedOwner = (owner: typeof ConnectionOwner.Type, access: CurrentAccess["Service"]) =>
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

const environmentFailure = (error: HostedEnvironmentError) => {
  if (error.kind === "forbidden") return Forbidden.make({ message: "Environment operation was rejected" })
  if (error.kind === "missing") return NotFound.make({ message: error.message })
  if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
  return ServiceUnavailable.make({ message: "Environment service unavailable" })
}

const projectFailure = (error: { readonly kind?: string | undefined; readonly message: string }) => {
  if (error.kind === "forbidden") return Forbidden.make({ message: "Project operation was rejected" })
  if (error.kind === "conflict") return Conflict.make({ message: error.message })
  if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
  return ServiceUnavailable.make({ message: "Product service unavailable" })
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
      createProject: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const project = yield* dependencies.product
            .createProject({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
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
      admitRunner: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const executorUrl = new URL("/api/v1/runners", request.url)
          executorUrl.protocol = "wss:"
          return yield* dependencies.executor
            .admitRunner({
              threadId: params.threadId,
              workspaceFingerprint: payload.workspace_fingerprint,
              executorUrl: executorUrl.toString(),
              principal: authenticatedPrincipal(access),
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "assignment-missing") return NotFound.make({ message: "Thread is unavailable" })
                if (error.kind === "assignment-conflict" || error.kind === "fenced")
                  return Conflict.make({ message: "Runner admission is unavailable" })
                return Forbidden.make({ message: "Runner admission was rejected" })
              }),
            )
        }),
      registerRunner: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          yield* dependencies.product
            .registerRunner({
              principal: authenticatedPrincipal(access),
              checkoutFingerprint: params.checkoutFingerprint,
              registration: payload,
            })
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Runner registration failed" })))
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
                  : ServiceUnavailable.make({ message: "Runner preference failed" }),
              ),
            )
        }),
      pollRunner: ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const principal = authenticatedPrincipal(access)
          const candidate = yield* dependencies.product
            .pollRunner({
              principal,
              checkoutFingerprint: params.checkoutFingerprint,
            })
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Runner polling failed" })))
          if (candidate === undefined) return { _tag: "Waiting" as const }
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const executorUrl = new URL("/api/v1/runners", request.url)
          executorUrl.protocol = "wss:"
          const admission = yield* dependencies.executor
            .admitRunner({
              threadId: candidate.threadId,
              workspaceFingerprint: params.checkoutFingerprint,
              executorUrl: executorUrl.toString(),
              principal,
            })
            .pipe(Effect.mapError(() => Conflict.make({ message: "Runner admission is unavailable" })))
          return { _tag: "Admitted" as const, ...admission }
        }),
      inspectRecovery: ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const operations = yield* dependencies.recovery
            .inspect({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              runId: params.runId,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "not-found") return NotFound.make({ message: error.message })
                if (error.kind === "forbidden") return Forbidden.make({ message: error.message })
                return ServiceUnavailable.make({ message: error.message })
              }),
            )
          return { operations }
        }),
      resolveRecovery: ({ headers, params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          let resolution: RecoveryResolution
          if (payload.action === "retry") resolution = { _tag: "Retry" }
          else if (payload.action === "accept") resolution = { _tag: "Accept", value: payload.value }
          else resolution = { _tag: "Abort", reason: payload.reason }
          return yield* dependencies.recovery
            .resolve({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              runId: params.runId,
              operationId: params.operationId,
              idempotencyKey: headers["idempotency-key"],
              resolution,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "not-found") return NotFound.make({ message: error.message })
                if (error.kind === "forbidden") return Forbidden.make({ message: error.message })
                if (error.kind === "conflict") return Conflict.make({ message: error.message })
                if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
                return ServiceUnavailable.make({ message: error.message })
              }),
            )
        }),
      publishRepository: ({ headers, params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.publication === undefined)
            return yield* ServiceUnavailable.make({ message: "Repository publication service unavailable" })
          const result = yield* dependencies.publication
            .publish({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              idempotencyKey: headers["idempotency-key"],
              commitSha: payload.commit_sha,
              ...(payload.target_branch === undefined ? {} : { targetRef: payload.target_branch }),
              title: payload.title,
              body: payload.body,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "missing") return NotFound.make({ message: error.message })
                if (error.kind === "forbidden") return Forbidden.make({ message: error.message })
                if (error.kind === "conflict") return Conflict.make({ message: error.message })
                if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
                return ServiceUnavailable.make({ message: error.message })
              }),
            )
          return {
            publicationId: result.id,
            state: result.state,
            branch: result.sourceBranch,
            ref: result.sourceRef,
            commitSha: result.sourceCommitSha,
            targetBranch: result.target.ref,
            targetCommitSha: result.target.commitSha,
            targetProtected: result.target.protected,
            pushResult: result.pushResult,
            pullRequestResult: result.pullRequestResult,
          }
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
              owner: hostedOwner(payload.owner, access),
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
              owner: hostedOwner(payload.owner, access),
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
              owner: hostedOwner(payload.owner, access),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
          return { credentials: [...credentials] }
        }),
      putOpenAiAccount: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .putOpenAiAccount({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              accessToken: payload.access_token,
              idToken: payload.id_token,
              refreshToken: payload.refresh_token,
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      getOpenAiAccount: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .openAiAccountStatus({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      revokeOpenAiAccount: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .revokeOpenAiAccount({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      putEnvironment: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .put({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              scope: payload.scope,
              name: params.name,
              classification: payload.classification,
              phases: payload.phases,
              value: payload.value,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      revokeEnvironment: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .revoke({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              scope: payload.scope,
              name: params.name,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      putEnvironmentPolicy: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          yield* dependencies.environment
            .putOrganizationPolicy({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              personalOverrides: payload.personal_overrides,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      approveEnvironmentSource: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .approveSource({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              sourceOwner: payload.source_owner,
              sourceCommitSha: payload.source_commit_sha,
              phase: payload.phase,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      revokeEnvironmentSource: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .revokeSourceApproval({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              sourceOwner: payload.source_owner,
              sourceCommitSha: payload.source_commit_sha,
              phase: payload.phase,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      putEgress: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .putEgress({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(payload.owner, access),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              phase: params.phase,
              allow: payload.allow,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      listToolAudit: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          const records = yield* dependencies.toolPolicy
            .list({
              principal: { userId: access.principal.userId },
              owner: hostedOwner(payload.owner, access),
              limit: payload.limit ?? 100,
            })
            .pipe(
              Effect.mapError((error) =>
                error.kind === "forbidden"
                  ? Forbidden.make({ message: "Audit owner is unavailable" })
                  : ServiceUnavailable.make({ message: "Tool audit service unavailable" }),
              ),
            )
          return { records: [...records] }
        }),
    }),
  )

export const isRikaApiPath = (pathname: string) =>
  pathname === "/healthz" ||
  pathname === "/readyz" ||
  pathname === "/api/v1/auth/cli/devices/revoke-all" ||
  pathname === "/api/v1/me/context" ||
  pathname === "/api/v1/projects" ||
  pathname === "/api/v1/thread-sessions" ||
  pathname === "/api/v1/models" ||
  pathname === "/api/v1/environment-policy" ||
  pathname === "/api/v1/environment-approvals" ||
  pathname === "/api/v1/provider-accounts/openai" ||
  pathname === "/api/v1/provider-accounts/openai/status" ||
  pathname === "/api/v1/provider-credentials/list" ||
  pathname === "/api/v1/tool-audit-records/list" ||
  /^\/api\/v1\/(environment|egress)\/[^/]+$/.test(pathname) ||
  /^\/api\/v1\/provider-credentials\/[^/]+$/.test(pathname) ||
  /^\/api\/v1\/runners\/[^/]+(?:\/remote-thread-creation|\/admissions)?$/.test(pathname) ||
  /^\/api\/v1\/threads\/[^/]+\/runner-admissions$/.test(pathname) ||
  /^\/api\/v1\/threads\/[^/]+\/repository-publications$/.test(pathname) ||
  /^\/api\/v1\/threads\/[^/]+\/runs\/[^/]+\/recovery(?:\/[^/]+)?$/.test(pathname)

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
