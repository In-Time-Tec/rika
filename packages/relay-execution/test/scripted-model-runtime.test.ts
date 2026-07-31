import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeConstantModel, makeScriptedModel } from "../src/model/provider/scripted-model-runtime"

it.effect("scripted and constant fixtures register explicit zero pricing", () =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedModel('[{"parts":[{"type":"text","text":"ok"}]}]')
    const constant = yield* makeConstantModel("ok")
    expect(scripted.registration.metadata?.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
    expect(constant.registration.metadata?.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
  }),
)
