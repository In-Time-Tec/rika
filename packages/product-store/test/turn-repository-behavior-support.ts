import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

export type CurrentCreateInput = Omit<
  Parameters<TurnContract.Interface["createForSubmission"]>[0],
  "executionRoute" | "queueCapacity"
> & {
  readonly executionRoute?: Turn.ExecutionRoutePin
  readonly queueCapacity?: number
}

export const create = (repository: TurnContract.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: Turn.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })

export const stopIntentContract = (label: string, layer: Layer.Layer<TurnRepository.Service, never, never>) =>
  it.effect(`${label} keeps a stopped turn out of the resumable set`, () =>
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

      // A stopped turn is still unfinished, but nothing may re-follow it after a restart.
      expect(yield* repository.listNonterminal).toEqual([])
      expect((yield* repository.listStopRequested).map((turn) => turn.id)).toEqual([stopped.id])
      expect((yield* repository.get(stopped.id))?.stopIntent).toBe("requested")
    }).pipe(provideLayer(layer)),
  )

export { expect, it }
export { Effect, Layer }
export { Thread, TurnRepository, TurnContract, Turn }
