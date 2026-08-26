import { Schema } from "effect"
import {
  EnvironmentClassification,
  EnvironmentPhase,
  EnvironmentScope,
  EnvironmentValueName,
  SourceCommitSha,
} from "@rika/product/environment-policy"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { Authorization, ConnectionOwner, Forbidden, NotFound, ServiceUnavailable, Unprocessable } from "../access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
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

export class EnvironmentGroup extends HttpApiGroup.make("environment", { topLevel: true })
  .add(
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
  )
  .middleware(Authorization) {}
