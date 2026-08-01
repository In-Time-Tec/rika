import { withResilience } from "../../model/routing/relay-model-registry"
import { Client, Ids } from "@relayfx/sdk"
import { Effect } from "effect"
import { ModelRegistry, type ModelResilience } from "@batonfx/core"
import type { Tool } from "effect/unstable/ai"
import type { LayerOptions } from "./relay-execution-layer"
import { decodeExecutionRouteMetadata } from "./relay-execution-id-codec"

export const registrationsFor = <AdditionalTools extends Record<string, Tool.Any>, R>(
  options: LayerOptions<AdditionalTools, R>,
) => [
  withResilience({ registration: options.registration, resilience: options.modelResilience }),
  ...(options.additionalRegistrations ?? []).map((registration) =>
    withResilience({ registration, resilience: options.modelResilience }),
  ),
]

export const registerModel: (
  registry: ModelRegistry.Interface,
  registration: ModelRegistry.Registration,
  resilience: ModelResilience.Interface | undefined,
) => Effect.Effect<void> = Effect.fn("RelayExecution.registerModel")(function* (
  registry: ModelRegistry.Interface,
  registration: ModelRegistry.Registration,
  resilience: ModelResilience.Interface | undefined,
): Effect.fn.Return<void> {
  yield* registry.register({ registration: withResilience({ registration, resilience }) })
})

export const zeroPriceFromMetadata = (metadata: ModelRegistry.Metadata | undefined) =>
  metadata?.pricing !== undefined &&
  typeof metadata.pricing === "object" &&
  metadata.pricing !== null &&
  (metadata.pricing as { inputPerMTok?: unknown }).inputPerMTok === 0 &&
  (metadata.pricing as { outputPerMTok?: unknown }).outputPerMTok === 0
    ? { amount: 0, currency: "USD" }
    : undefined

export const pinnedRouteForExecution = (input: {
  readonly client: Client.Interface
  readonly execution: import("@relayfx/sdk").Execution.Execution
}) =>
  Effect.gen(function* () {
    let current: import("@relayfx/sdk").Execution.Execution | undefined = input.execution
    for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
      const route = decodeExecutionRouteMetadata(current.metadata)
      if (route !== undefined) return route
      const parentId: unknown = current.metadata?.parent_execution_id
      current =
        typeof parentId === "string" ? yield* input.client.executions.get(Ids.ExecutionId.make(parentId)) : undefined
    }
    return undefined
  })
