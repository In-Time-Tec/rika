import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { HostedModelProvider } from "../../hosted/environment/provider-credentials"
import { Authorization, ConnectionOwner, Forbidden, ServiceUnavailable, Unprocessable } from "../access"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
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

export class ModelsGroup extends HttpApiGroup.make("models", { topLevel: true })
  .add(
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
  )
  .middleware(Authorization) {}
