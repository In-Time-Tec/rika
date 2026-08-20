import { Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import type { Executor } from "@rika/kernel/executor-runtime"
import { CellResponse, type CellRequest, type CellResponse as CellResponseValue } from "./protocol"

export class CellError extends Schema.TaggedError<CellError>()("CellError", {
  kind: Schema.Literals(["execution", "fenced", "workspace"]),
  message: Schema.String,
}) {}

export interface Options extends Executor<CellRequest, CellResponse, CellError> {
  readonly workspace: string
  readonly read: (operationKey: string) => Effect.Effect<State | undefined, CellError>
  readonly write: (operationKey: string, state: State) => Effect.Effect<void, CellError>
}

export interface Interface {
  readonly execute: (request: CellRequest) => Effect.Effect<CellResponse, CellError>
}

export class Cells extends Context.Service<Cells, Interface>()("@rika/remote-execution/cells") {}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const State = Schema.Union([
  Schema.TaggedStruct("Running", { attempt: NonNegativeInt }),
  Schema.TaggedStruct("Completed", { attempt: NonNegativeInt, response: CellResponse }),
])
export type State = typeof State.Type

interface Entry {
  readonly attempt: number
  readonly result: Deferred.Deferred<CellResponseValue, CellError>
}

const unknown: CellResponseValue = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Cell operation outcome is unknown" },
}

export const layer = (options: Options): Layer.Layer<Cells> =>
  Layer.effect(
    Cells,
    Effect.gen(function* () {
      const entries = yield* Ref.make(new Map<string, Entry>())
      const execute: Interface["execute"] = Effect.fn("Cells.execute")(function* (request) {
        if (request.workspace !== options.workspace)
          return yield* CellError.make({ kind: "workspace", message: "Cell workspace does not match this executor" })
        const attempt = request.attempt ?? 0
        const result = yield* Deferred.make<CellResponseValue, CellError>()
        const entry = yield* Ref.modify(entries, (current) => {
          const known = current.get(request.operationKey)
          if (known !== undefined) return [known, current] as const
          const next = new Map(current)
          const fresh = { attempt, result }
          next.set(request.operationKey, fresh)
          return [fresh, next] as const
        })
        if (attempt < entry.attempt)
          return yield* CellError.make({ kind: "fenced", message: "Cell operation attempt is stale" })
        if (entry.result === result) {
          const operation = Effect.gen(function* () {
            const stored = yield* options.read(request.operationKey)
            if (stored !== undefined) {
              if (attempt < stored.attempt)
                return yield* CellError.make({ kind: "fenced", message: "Cell operation attempt is stale" })
              return stored._tag === "Completed" ? stored.response : unknown
            }
            yield* options.write(request.operationKey, { _tag: "Running", attempt })
            const response = yield* options.execute(request).pipe(
              Effect.catchCause(() =>
                Effect.succeed<CellResponseValue>({
                  _tag: "DomainFailure",
                  failure: { kind: "execution", message: "Cell execution failed" },
                }),
              ),
            )
            yield* options.write(request.operationKey, { _tag: "Completed", attempt, response })
            return response
          })
          yield* operation.pipe(
            Effect.matchEffect({
              onFailure: (error) => Deferred.fail(result, error),
              onSuccess: (response) => Deferred.succeed(result, response),
            }),
          )
        }
        return yield* Deferred.await(entry.result)
      })
      return Cells.of({ execute })
    }),
  )
