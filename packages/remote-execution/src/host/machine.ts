import * as BunServices from "@effect/platform-bun/BunServices"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { MediaAnalysisError, analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { Cause, Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { MachineOutcome, MachineRequest, type MachineOutcome as MachineOutcomeValue } from "../protocol/messages"

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

export class Machine extends Context.Service<Machine, Interface>()("@rika/remote-execution/host/machine") {}

interface Entry {
  readonly requestDigest: string
  readonly result: Deferred.Deferred<MachineOutcomeValue, MachineError>
}

const run = (
  request: MachineRequest,
): Effect.Effect<
  MachineOutcomeValue,
  never,
  CodingToolRuntime.Service | ShellProcessRegistry.Service | McpRuntime.McpRuntimeService
> => {
  switch (request._tag) {
    case "CodingTool":
      return Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request.request)).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (result) => ({ _tag: "Success" as const, value: { _tag: "CodingTool" as const, result } }),
        }),
      )
    case "ProcessStop":
      return Effect.flatMap(ShellProcessRegistry.Service, (processes) => processes.cancel(request.processId)).pipe(
        Effect.match({
          onFailure: (failure) => ({
            _tag: "Failure" as const,
            failure: { _tag: "ProcessStopFailed" as const, message: failure.message },
          }),
          onSuccess: () => ({ _tag: "Success" as const, value: { _tag: "ProcessStopped" as const } }),
        }),
      )
    case "McpDiscover":
      return Effect.scoped(McpRuntime.discover(request.server)).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (tools) => ({ _tag: "Success" as const, value: { _tag: "McpDiscovered" as const, tools } }),
        }),
      )
    case "McpCall":
      return Effect.scoped(McpRuntime.call(request.server, request.tool, request.input)).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (content) => ({ _tag: "Success" as const, value: { _tag: "McpCalled" as const, content } }),
        }),
      )
  }
}

export const layer = (
  options: Options,
): Layer.Layer<
  Machine,
  never,
  CodingToolRuntime.Service | ShellProcessRegistry.Service | McpRuntime.McpRuntimeService
> =>
  Layer.effect(
    Machine,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        CodingToolRuntime.Service | ShellProcessRegistry.Service | McpRuntime.McpRuntimeService
      >()
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
            const outcome = yield* run(input.request).pipe(Effect.provideContext(services))
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

export const workspaceLayer = (options: Options & { readonly workspace: string }): Layer.Layer<Machine> => {
  const tools = Layer.orDie(
    CodingToolRuntime.layerWithRegistry(options.workspace).pipe(
      Layer.provide(
        analyzerTestLayer(() => Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" }))),
      ),
      Layer.provide(
        Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
      Layer.provide(BunServices.layer),
    ),
  )
  return layer(options).pipe(Layer.provide(Layer.merge(tools, McpRuntime.layer)), Layer.provide(BunServices.layer))
}
