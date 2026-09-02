import * as BunServices from "@effect/platform-bun/BunServices"
import * as LocalTools from "@rika/execution/local-tools"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import { Cause, Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { MachineOutcome, MachineRequest, type MachineOutcome as MachineOutcomeValue } from "../../protocol/messages"
import * as NativeToolSubprocess from "./native-tool-subprocess"

export const NativeToolState = Schema.Union([
  Schema.TaggedStruct("Running", { requestDigest: Schema.String }),
  Schema.TaggedStruct("Completed", { requestDigest: Schema.String, outcome: MachineOutcome }),
])
export type NativeToolState = typeof NativeToolState.Type

export class NativeToolError extends Schema.TaggedError<NativeToolError>()("NativeToolError", {
  message: Schema.String,
}) {}

interface Options {
  readonly read: (machineId: string) => Effect.Effect<NativeToolState | undefined, NativeToolError>
  readonly write: (machineId: string, state: NativeToolState) => Effect.Effect<void, NativeToolError>
}

interface Interface {
  readonly execute: (input: {
    readonly machineId: string
    readonly requestDigest: string
    readonly request: MachineRequest
  }) => Effect.Effect<MachineOutcomeValue, NativeToolError>
  readonly cancel: (input: {
    readonly machineId: string
    readonly requestDigest: string
    readonly admitted?: boolean
  }) => Effect.Effect<MachineOutcomeValue, NativeToolError>
}

export class NativeToolService extends Context.Service<NativeToolService, Interface>()(
  "@rika/remote-execution/host/machinery/native-tool/NativeToolService",
) {}

interface Entry {
  readonly requestDigest: string
  readonly result: Deferred.Deferred<MachineOutcomeValue, NativeToolError>
}

const layerWith = <R>(
  options: Options,
  executeRequest: (request: MachineRequest) => Effect.Effect<MachineOutcomeValue, never, R>,
): Layer.Layer<NativeToolService, never, R> =>
  Layer.effect(
    NativeToolService,
    Effect.gen(function* () {
      const services = yield* Effect.context<R>()
      const entries = yield* Ref.make(new Map<string, Entry>())
      const execute: Interface["execute"] = Effect.fn("NativeToolService.execute")(function* (input) {
        const result = yield* Deferred.make<MachineOutcomeValue, NativeToolError>()
        const entry = yield* Ref.modify(entries, (current) => {
          const known = current.get(input.machineId)
          if (known !== undefined) return [known, current] as const
          const fresh = { requestDigest: input.requestDigest, result }
          return [fresh, new Map(current).set(input.machineId, fresh)] as const
        })
        if (entry.requestDigest !== input.requestDigest)
          return { _tag: "Fenced", message: "native tool operation id conflicts with a different request" }
        if (entry.result === result) {
          const operation = Effect.gen(function* () {
            const stored = yield* options.read(input.machineId)
            if (stored !== undefined) {
              if (stored.requestDigest !== input.requestDigest)
                return {
                  _tag: "Fenced" as const,
                  message: "native tool operation id conflicts with a persisted request",
                }
              return stored._tag === "Completed"
                ? stored.outcome
                : ({
                    _tag: "Unknown",
                    message: "native tool operation outcome is unknown after executor restart",
                  } as const)
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
                  : Deferred.fail(result, NativeToolError.make({ message: String(Cause.squash(cause)) })),
              onSuccess: (outcome) => Deferred.succeed(result, outcome),
            }),
          )
        }
        return yield* Deferred.await(entry.result)
      })
      const cancel: Interface["cancel"] = Effect.fn("NativeToolService.cancel")(function* (input) {
        const entry = (yield* Ref.get(entries)).get(input.machineId)
        if (entry !== undefined && entry.requestDigest !== input.requestDigest)
          return { _tag: "Fenced", message: "native tool operation id conflicts with a different request" }
        const stored = yield* options.read(input.machineId)
        if (stored === undefined) {
          if (entry === undefined && input.admitted !== true)
            return { _tag: "Unknown", message: "native tool operation was not retained before cancellation" }
          const outcome = { _tag: "Cancelled" as const }
          yield* options.write(input.machineId, { _tag: "Completed", requestDigest: input.requestDigest, outcome })
          if (entry !== undefined) yield* Deferred.succeed(entry.result, outcome)
          return outcome
        }
        if (stored.requestDigest !== input.requestDigest)
          return { _tag: "Fenced", message: "native tool operation id conflicts with a persisted request" }
        if (stored._tag === "Completed") return stored.outcome
        if (entry === undefined)
          return { _tag: "Unknown", message: "native tool operation outcome is unknown after executor restart" }
        const outcome = { _tag: "Cancelled" as const }
        yield* options.write(input.machineId, { _tag: "Completed", requestDigest: input.requestDigest, outcome })
        yield* Deferred.succeed(entry.result, outcome)
        return outcome
      })
      return NativeToolService.of({ execute, cancel })
    }),
  )

const layer = (options: Options): Layer.Layer<NativeToolService, never, NativeToolRuntime.Service> =>
  layerWith(options, (request) =>
    Effect.flatMap(NativeToolRuntime.Service, (runtime) => runtime.run(request.request)).pipe(
      Effect.match({
        onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
        onSuccess: (result) => ({ _tag: "Success" as const, value: { _tag: "NativeTool" as const, result } }),
      }),
    ),
  )

export const nativeToolLayer = (
  options: Options & {
    readonly workspace: string
    readonly workspaceUser?: string
    readonly environment?: Readonly<Record<string, string>>
  },
): Layer.Layer<NativeToolService> => {
  const workspaceUser = options.workspaceUser
  if (workspaceUser === undefined)
    return layer(options).pipe(
      Layer.provide(
        Layer.effect(
          NativeToolRuntime.Service,
          Effect.map(NativeToolRuntime.Service, NativeToolRuntime.Service.of),
        ).pipe(Layer.provide(LocalTools.layer(options.workspace))),
      ),
      Layer.provide(BunServices.layer),
    )
  return Layer.effect(
    NativeToolService,
    Effect.gen(function* () {
      const process = yield* NativeToolSubprocess.make({
        workspace: options.workspace,
        workspaceUser,
        environment: options.environment ?? {},
      }).pipe(Effect.orDie)
      const context = yield* Layer.build(
        layerWith(options, (request) =>
          process
            .execute(request.request)
            .pipe(Effect.catch((error) => Effect.succeed({ _tag: "Unknown" as const, message: error.message }))),
        ),
      )
      return Context.get(context, NativeToolService)
    }),
  ).pipe(Layer.provide(BunServices.layer))
}
