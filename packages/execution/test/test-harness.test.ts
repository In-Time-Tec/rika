import { ModelRegistry } from "generalist"
import { it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { expect } from "vitest"
import * as ScriptedModel from "../src/scripted-model"

it.effect("registers scripted responses for the Generalist test route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        ScriptedModel.layer({ script: '[{"parts":[{"type":"text","text":"completed"}]}]' }),
      )
      const registry = Context.get(context, ModelRegistry.ModelRegistry)

      expect(yield* registry.registrations).toMatchObject([
        { provider: "test", model: "test", registrationKey: "test" },
      ])
    }),
  ),
)
