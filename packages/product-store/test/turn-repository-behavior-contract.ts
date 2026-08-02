import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { create, provideLayer } from "./turn-repository-behavior-setup"

export function stopIntentContract(label: string, layer: Layer.Layer<TurnRepository.Service, never, never>): void
export function stopIntentContract(layer: Layer.Layer<TurnRepository.Service, never, never>): (label: string) => void
export function stopIntentContract(
  labelOrLayer: string | Layer.Layer<TurnRepository.Service, never, never>,
  layer?: Layer.Layer<TurnRepository.Service, never, never>,
): void | ((label: string) => void) {
  if (typeof labelOrLayer !== "string") {
    if (layer !== undefined) throw new Error("Invalid stop intent contract arguments")
    return (label) => stopIntentContract(label, labelOrLayer)
  }
  if (layer === undefined) throw new Error("Invalid stop intent contract arguments")
  return it.effect(`${labelOrLayer} keeps a stopped turn out of the resumable set`, () =>
    Effect.gen(function* () {
      const repository = yield* TurnRepository.Service
      const threadId = Thread.ThreadId.make("stop-thread")
      const stopped = yield* create(repository, {
        id: Turn.TurnId.make("stopped-turn"),
        threadId,
        prompt: "stop me",
        now: 1,
      })
      expect(stopped.stopIntent).toBe("none")
      expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([stopped.id])
      expect(yield* repository.listStopRequested).toEqual([])

      const marked = yield* repository.requestStop(stopped.id, 2)
      expect(marked?.stopIntent).toBe("requested")

      expect(yield* repository.listNonterminal).toEqual([])
      expect((yield* repository.listStopRequested).map((turn) => turn.id)).toEqual([stopped.id])
      expect((yield* repository.get(stopped.id))?.stopIntent).toBe("requested")
    }).pipe(provideLayer(layer)),
  )
}

export { Thread, TurnRepository, TurnContract, Turn }
