import { Schema } from "effect"
import { Account } from "@rika/identity"
import { IdentityContext, Project } from "@rika/product/hosted-identity-context"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import {
  Authorization,
  BadRequest,
  Conflict,
  ConnectionOwner,
  Forbidden,
  NotFound,
  ServiceUnavailable,
  Unprocessable,
} from "./access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const ProjectCreateRequest = strict(
  Schema.Struct({
    owner: ConnectionOwner,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
)
const ProjectCreateResponse = Project.pipe(HttpApiSchema.status(201))
export const CliRegistrationRequest = strict(
  Schema.Struct({
    reference_id: Schema.String.check(Schema.isPattern(/^cli-device:[0-9a-f-]{36}$/i)),
    token_endpoint_auth_method: Schema.Literal("none"),
    grant_types: Schema.Array(Schema.Literals(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"])),
    scope: Schema.NonEmptyString,
    resource: Schema.NonEmptyString,
    dpop_jkt: Schema.NonEmptyString,
    jwk: Schema.Struct({
      kty: Schema.Literal("EC"),
      crv: Schema.Literal("P-256"),
      x: Schema.NonEmptyString,
      y: Schema.NonEmptyString,
    }),
  }),
)
export const CliRegistrationResponse = Schema.Struct({ client_id: Schema.NonEmptyString }).pipe(
  HttpApiSchema.status(201),
)
const CliDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  current: Schema.Boolean,
  lastSeenAt: Schema.optional(Schema.String),
})
const CliDevicesResponse = Schema.Struct({ devices: Schema.Array(CliDevice) })
const InvitationRequest = strict(
  Schema.Struct({ email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) }),
)

export class PublicIdentityGroup extends HttpApiGroup.make("publicIdentity", { topLevel: true }).add(
  HttpApiEndpoint.post("registerCli", "/api/v1/auth/cli/registrations", {
    payload: CliRegistrationRequest,
    success: CliRegistrationResponse,
    error: [BadRequest, ServiceUnavailable],
  }),
) {}

export class IdentityGroup extends HttpApiGroup.make("identity", { topLevel: true })
  .add(
    HttpApiEndpoint.get("account", "/api/account", {
      success: Account,
      error: ServiceUnavailable,
    }),
    HttpApiEndpoint.get("listDevices", "/api/v1/auth/cli/devices", {
      success: CliDevicesResponse,
      error: ServiceUnavailable,
    }),
    HttpApiEndpoint.post("revokeDevice", "/api/v1/auth/cli/devices/:deviceId/revoke", {
      params: { deviceId: Schema.NonEmptyString },
      success: HttpApiSchema.NoContent,
      error: [NotFound, ServiceUnavailable],
    }),
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
    HttpApiEndpoint.post("inviteMember", "/api/v1/organizations/:organizationId/invitations", {
      params: { organizationId: Schema.NonEmptyString },
      payload: InvitationRequest,
      success: Schema.Unknown,
      error: [BadRequest, NotFound, ServiceUnavailable],
    }),
  )
  .middleware(Authorization) {}
