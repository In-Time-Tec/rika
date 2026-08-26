import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { MachineOutcome, MachineRequest, type MachineOutcome as MachineOutcomeValue } from "./protocol"
import * as MachineExecution from "./machine-execution"
import * as MachineProcess from "./machine-process"

export const State = Schema.Union([
  Schema.TaggedStruct("Running", { requestDigest: Schema.String }),
  Schema.TaggedStruct("Completed", { requestDigest: Schema.String, outcome: MachineOutcome }),
])
export type State = typeof State.Type

export class MachineError extends Schema.TaggedError<MachineError>()("MachineError", {
  message: Schema.String,
}) {}

export interface Options {
  readonly read: (machineId: string) => Effect.Effect<State | undefined, MachineError>
  readonly write: (machineId: string, state: State) => Effect.Effect<void, MachineError>
}

export interface Interface {
  readonly execute: (input: {
    readonly machineId: string
    readonly requestDigest: string
    readonly request: MachineRequest
  }) => Effect.Effect<MachineOutcomeValue, MachineError>
}

export class Machine extends Context.Service<Machine, Interface>()("@rika/remote-execution/machine") {}

interface Entry {
  readonly requestDigest: string
  readonly result: Deferred.Deferred<MachineOutcomeValue, MachineError>
}

const layerWith = <R>(
  options: Options,
  executeRequest: (request: MachineRequest) => Effect.Effect<MachineOutcomeValue, never, R>,
): Layer.Layer<Machine, never, R> =>
  Layer.effect(
    Machine,
    Effect.gen(function* () {
      const services = yield* Effect.context<R>()
      const entries = yield* Ref.make(new Map<string, Entry>())
      const execute: Interface["execute"] = Effect.fn("Machine.execute")(function* (input) {
        const result = yield* Deferred.make<MachineOutcomeValue, MachineError>()
        const entry = yield* Ref.modify(entries, (current) => {
          const known = current.get(input.machineId)
          if (known !== undefined) return [known, current] as const
          const fresh = { requestDigest: input.requestDigest, result }
          return [fresh, new Map(current).set(input.machineId, fresh)] as const
        })
        if (entry.requestDigest !== input.requestDigest)
          return { _tag: "Fenced", message: "machine call id conflicts with a different request" }
        if (entry.result === result) {
          const operation = Effect.gen(function* () {
            const stored = yield* options.read(input.machineId)
            if (stored !== undefined) {
              if (stored.requestDigest !== input.requestDigest)
                return { _tag: "Fenced" as const, message: "machine call id conflicts with a persisted request" }
              return stored._tag === "Completed"
                ? stored.outcome
                : ({ _tag: "Unknown", message: "machine call outcome is unknown after executor restart" } as const)
            }
            yield* options.write(input.machineId, { _tag: "Running", requestDigest: input.requestDigest })
            const outcome = yield* executeRequest(input.request).pipe(Effect.provideContext(services))
            yield* options.write(input.machineId, { _tag: "Completed", requestDigest: input.requestDigest, outcome })
            return outcome
          })
          yield* operation.pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Deferred.fail(result, MachineError.make({ message: String(Cause.squash(cause)) })),
              onSuccess: (outcome) => Deferred.succeed(result, outcome),
            }),
          )
        }
        return yield* Deferred.await(entry.result)
      })
      return Machine.of({ execute })
    }),
  )

export const layer = (options: Options): Layer.Layer<Machine, never, MachineExecution.Requirements> =>
  layerWith(options, MachineExecution.execute)

export const workspaceLayer = (
  options: Options & {
    readonly workspace: string
    readonly workspaceUser?: string
    readonly environment?: Readonly<Record<string, string>>
  },
): Layer.Layer<Machine> =>
  (options.workspaceUser === undefined
    ? layer(options).pipe(Layer.provide(MachineExecution.layer(options.workspace)))
    : Layer.effect(
        Machine,
        Effect.gen(function* () {
          const process = yield* MachineProcess.make({
            workspace: options.workspace,
            workspaceUser: options.workspaceUser as string,
            environment: options.environment ?? {},
          }).pipe(Effect.orDie)
          const context = yield* Layer.build(
            layerWith(options, (request) =>
              process
                .execute(request)
                .pipe(Effect.catch((error) => Effect.succeed({ _tag: "Unknown" as const, message: error.message }))),
            ),
          )
          return Context.get(context, Machine)
        }),
      )
  ).pipe(Layer.provide(BunServices.layer))
