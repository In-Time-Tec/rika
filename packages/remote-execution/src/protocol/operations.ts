import { Context, Effect, Fiber, Layer, Ref, Schema } from "effect"
import type { OperationFence, TerminalOutcome } from "./messages"

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  kind: Schema.Literals(["fenced", "missing-key", "quiesced"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly run: <A, E>(fence: OperationFence, work: Effect.Effect<A, E>) => Effect.Effect<A, E | OperationError>
  readonly quiesce: Effect.Effect<ReadonlyArray<{ readonly operationKey: string; readonly outcome: TerminalOutcome }>>
}

export class Supervisor extends Context.Service<Supervisor, Interface>()(
  "@rika/remote-execution/protocol/operations/Supervisor",
) {}

export const layer: Layer.Layer<Supervisor> = Layer.effect(
  Supervisor,
  Effect.gen(function* () {
    const attempts = yield* Ref.make(new Map<string, number>())
    const active = yield* Ref.make(new Map<string, Fiber.Fiber<unknown, unknown>>())
    const stopped = yield* Ref.make(false)
    const run: Interface["run"] = Effect.fn("Operations.run")(function* (fence, work) {
      if (fence.operationKey.length === 0)
        return yield* OperationError.make({ kind: "missing-key", message: "operationKey is required" })
      if (yield* Ref.get(stopped)) return yield* OperationError.make({ kind: "quiesced", message: "lease was lost" })
      const known = (yield* Ref.get(attempts)).get(fence.operationKey)
      if (known !== undefined && fence.attempt < known)
        return yield* OperationError.make({ kind: "fenced", message: "operation attempt is stale" })
      yield* Ref.update(attempts, (values) => new Map(values).set(fence.operationKey, fence.attempt))
      const fiber = yield* Effect.forkChild(work)
      yield* Ref.update(active, (values) => new Map(values).set(fence.operationKey, fiber))
      return yield* Fiber.join(fiber).pipe(
        Effect.ensuring(
          Ref.update(active, (values) => {
            const next = new Map(values)
            next.delete(fence.operationKey)
            return next
          }),
        ),
      )
    })
    const quiesce = Effect.gen(function* () {
      yield* Ref.set(stopped, true)
      const fibers = yield* Ref.get(active)
      yield* Effect.forEach(fibers.values(), Fiber.interrupt, { discard: true })
      yield* Ref.set(active, new Map())
      return [...fibers.keys()].map((operationKey) => ({ operationKey, outcome: "unknown" as const }))
    })
    return Supervisor.of({ run, quiesce })
  }),
)
