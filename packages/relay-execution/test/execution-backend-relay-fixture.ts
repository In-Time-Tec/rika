import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Schema } from "effect"

import * as ExecutionBackend from "@rika/product/execution-service"
import { modelRegistrationIdentity } from "@rika/product/execution-route-snapshot"

const executionModelRoute = (
  role: "main" | "oracle",
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionBackend.ExecutionModelRoute => ({
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
  compaction: { contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 50 },
})

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

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

export const fixture: {
  readonly executionModelRoute: typeof executionModelRoute
  readonly provide: typeof provide
  readonly runNative: typeof runNative
  readonly encodeJson: typeof encodeJson
  readonly decodeToolExecution: typeof decodeToolExecution
} = { executionModelRoute, provide, runNative, encodeJson, decodeToolExecution }
