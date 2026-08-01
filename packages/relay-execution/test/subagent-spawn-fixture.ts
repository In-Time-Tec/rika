import { Schema } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const decodeToolExecution = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      tool_execution: Schema.optional(
        Schema.Struct({ concurrency: Schema.Union([Schema.Finite, Schema.Literal("unbounded")]) }),
      ),
    }),
  ),
)

const parallelRootPrompt = "Explore alpha, beta, and gamma independently."
const nestedRootPrompt = "Coordinate the nested work."

const executionModelRoute = (
  role: ExecutionBackend.ExecutionRouteModelSnapshot["role"],
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
  effort = "medium",
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
  effort,
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
})

export const fixture = {
  terminal,
  encodeJson,
  decodeToolExecution,
  parallelRootPrompt,
  nestedRootPrompt,
  executionModelRoute,
}
