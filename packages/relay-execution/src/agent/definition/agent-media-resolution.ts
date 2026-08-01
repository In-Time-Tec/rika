import { Effect, Function, Schema } from "effect"
import type { ModelRegistry } from "@batonfx/core"
import { resolve } from "./baton-agent-definition"

type ResolvedProfile = ReturnType<ReturnType<typeof resolve>>

export class PainterUnavailableError extends Schema.TaggedErrorClass<PainterUnavailableError>()(
  "PainterUnavailableError",
  { message: Schema.String, provider: Schema.String, model: Schema.String },
) {}

const resolvePainterEffect = Effect.fn("AgentProfiles.resolvePainter")(function* (
  model: ModelRegistry.ModelSelection,
  mediaAvailable: boolean,
): Effect.fn.Return<ResolvedProfile, PainterUnavailableError> {
  if (!mediaAvailable) {
    return yield* PainterUnavailableError.make({
      message: "The configured model route does not provide the required media capability",
      provider: model.provider,
      model: model.model,
    })
  }
  return resolve("Painter", model)
})

export const resolvePainter: {
  (
    model: ModelRegistry.ModelSelection,
    mediaAvailable: boolean,
  ): Effect.Effect<ResolvedProfile, PainterUnavailableError>
  (
    mediaAvailable: boolean,
  ): (model: ModelRegistry.ModelSelection) => Effect.Effect<ResolvedProfile, PainterUnavailableError>
} = Function.dual(2, resolvePainterEffect)
