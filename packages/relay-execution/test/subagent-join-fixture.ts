import * as ExecutionBackend from "@rika/product/execution-service"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

const encodeJson = (value: unknown) => JSON.stringify(value)

const executionModelRoute = (
  role: ExecutionBackend.ExecutionRouteModelSnapshot["role"],
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionBackend.ExecutionRouteModelSnapshot => ({
  role,
  alias: role,
  model: selection.model,
  providerConnection: {
    provider: selection.provider,
    protocol: "test",
    baseUrl: "test://model",
    authentication: "none",
  },
  registrationIdentity: modelRegistrationIdentity(selection.registrationKey ?? role),
  effort: "medium",
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
})

export const fixture = { encodeJson, executionModelRoute }
