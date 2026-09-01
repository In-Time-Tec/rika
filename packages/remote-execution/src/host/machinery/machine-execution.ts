import * as LocalTools from "@rika/execution/local-tools"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import { Effect, Layer } from "effect"
import type { MachineOutcome, MachineRequest } from "../../protocol/messages"

export type Requirements = NativeToolRuntime.Service

export const execute = (request: MachineRequest): Effect.Effect<MachineOutcome, never, Requirements> =>
  Effect.flatMap(NativeToolRuntime.Service, (runtime) => runtime.run(request.request)).pipe(
    Effect.match({
      onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
      onSuccess: (result) => ({ _tag: "Success" as const, value: { _tag: "NativeTool" as const, result } }),
    }),
  )

export const layer = (
  workspace: string,
): Layer.Layer<
  NativeToolRuntime.Service,
  never,
  | import("effect").FileSystem.FileSystem
  | import("effect").Path.Path
  | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(NativeToolRuntime.Service, Effect.map(NativeToolRuntime.Service, NativeToolRuntime.Service.of)).pipe(
    Layer.provide(LocalTools.layer(workspace)),
  )
