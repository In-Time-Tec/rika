import { Context, Effect, Layer, Schema } from "effect"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware, HttpApiSchema } from "effect/unstable/httpapi"
import { accountAccess, type AccountAccess, type HttpDependencies } from "../server/http"
import type { HostedEnvironmentError } from "../hosted/environment/runtime"
import type { HostedProviderCredentialError } from "../hosted/environment/provider-credentials"
import type { AuthenticatedPrincipal } from "../hosted/product"

const Message = { message: Schema.String }
const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
export const ConnectionOwner = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal") })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organization_id: Schema.NonEmptyString })),
])
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", Message, { httpApiStatus: 401 }) {}
const UnauthorizedResponse = Unauthorized.pipe(
  HttpApiSchema.encodeToWithHeaders(
    {
      body: Unauthorized,
      headers: { "www-authenticate": Schema.String },
    },
    {
      decode: ({ body }) => body,
      encode: (error) => ({ body: error, headers: { "www-authenticate": 'Bearer realm="rika"' } }),
    },
  ),
)
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", Message, { httpApiStatus: 400 }) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", Message, { httpApiStatus: 403 }) {}
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", Message, { httpApiStatus: 404 }) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", Message, { httpApiStatus: 409 }) {}
export class Unprocessable extends Schema.TaggedError<Unprocessable>()("Unprocessable", Message, {
  httpApiStatus: 422,
}) {}
export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()("ServiceUnavailable", Message, {
  httpApiStatus: 503,
}) {}
export class CurrentAccess extends Context.Service<
  CurrentAccess,
  Extract<AccountAccess, { readonly _tag: "account" }>
>()("@rika/api/http-api/access/CurrentAccess") {}
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentAccess; requires: never }
>()("@rika/api/api/Authorization", { error: [UnauthorizedResponse, ServiceUnavailable] }) {}
export const authorizationLayer = (dependencies: HttpDependencies) =>
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
export const authenticatedPrincipal = (access: CurrentAccess["Service"]) => {
  const principal: AuthenticatedPrincipal = {
    userId: access.principal.userId,
    deviceId: access.deviceId!,
    clientId: access.principal.clientId!,
  }
  if (access.principal.dpopJkt !== undefined) Object.assign(principal, { dpopJkt: access.principal.dpopJkt })
  return principal
}
export const hostedOwner =
  (access: CurrentAccess["Service"]) =>
  (owner: { readonly kind: "personal" } | { readonly kind: "organization"; readonly organization_id: string }) =>
    owner.kind === "personal"
      ? { _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(access.principal.userId) }
      : { _tag: "OrganizationOwner" as const, organizationId: OrganizationId.make(owner.organization_id) }
export const providerCredentialFailure = (error: HostedProviderCredentialError) => {
  if (error.kind === "forbidden") return Forbidden.make({ message: "Provider credential operation was rejected" })
  if (error.kind === "invalid" || error.kind === "missing" || error.kind === "revoked")
    return Unprocessable.make({ message: error.message })
  return ServiceUnavailable.make({ message: "Provider credential service unavailable" })
}
export const environmentFailure = (error: HostedEnvironmentError) => {
  if (error.kind === "forbidden") return Forbidden.make({ message: "Environment operation was rejected" })
  if (error.kind === "missing") return NotFound.make({ message: error.message })
  if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
  return ServiceUnavailable.make({ message: "Environment service unavailable" })
}
export const projectFailure = (error: { readonly kind?: string; readonly message: string }) => {
  if (error.kind === "forbidden") return Forbidden.make({ message: "Project operation was rejected" })
  if (error.kind === "conflict") return Conflict.make({ message: error.message })
  if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
  return ServiceUnavailable.make({ message: "Product service unavailable" })
}

/**
 * Request decoding failures. The framework default is an empty 400, which leaves a client unable to say why the
 * server refused. The most common cause is a Rika CLI older than the API's wire contract, so the message names
 * the mismatched part and the fix.
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()("@rika/api/api/SchemaErrors", {
  error: BadRequest,
}) {}
const schemaIssueLimit = 400
const schemaErrorMessage = (input: { readonly kind: string; readonly issue: string; readonly endpoint: string }) => {
  const summary = input.issue.replace(/\s+/g, " ").trim()
  const bounded = summary.length > schemaIssueLimit ? `${summary.slice(0, schemaIssueLimit - 1)}…` : summary
  return `${input.kind} for ${input.endpoint} did not match this server's API (${bounded}). If this is the Rika CLI, run \`rika update\`.`
}
export const schemaErrorsLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (error, context) =>
  BadRequest.make({
    message: schemaErrorMessage({
      kind: error.kind,
      issue: error.cause.message,
      endpoint: `${context.endpoint.method} ${context.endpoint.path}`,
    }),
  }),
)
