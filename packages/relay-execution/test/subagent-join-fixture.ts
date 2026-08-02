import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { ModelRegistry } from "@batonfx/core"
import { Effect } from "effect"
import { Tool } from "effect/unstable/ai"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

const encodeJson = (value: unknown) => JSON.stringify(value)

const executionModelRoute = (
  role: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot["role"],
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionRouteSnapshot.ExecutionRouteModelSnapshot => ({
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

const testModelRegistration = (registration: ModelRegistry.Registration): ModelRegistry.Registration => ({
  ...registration,
  toolJsonSchemaCompiler: (tool: Tool.Any) => Effect.succeed(Tool.getJsonSchema(tool)),
})

export const fixture = { encodeJson, executionModelRoute, testModelRegistration }
