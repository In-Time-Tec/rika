import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer as kernelCellLayer } from "@rika/kernel/cell-executor"
import { Context, Crypto, Effect, Layer, Ref, Scope, Semaphore } from "effect"
import * as BindingProxy from "./binding-proxy"
import { CellError, Cells, layer as cellsLayer, type OutputChunk, type State as CellState } from "./cells"
import type { AccessWire, BindingOutcome, CellRequest, CellResponse } from "./protocol"

interface Runtime {
  readonly digest: string
  readonly cells: Cells["Service"]
  readonly proxy: BindingProxy.Interface
}

export interface Options {
  readonly workspaceIdentity: string
  readonly workspacePath: string
  readonly dataRoot: string
  readonly read: (operationKey: string) => Effect.Effect<CellState | undefined, CellError>
  readonly write: (operationKey: string, state: CellState) => Effect.Effect<void, CellError>
  readonly sendBinding: BindingProxy.Transport["send"]
}

export interface Interface {
  readonly execute: (
    request: CellRequest,
    output: (chunk: OutputChunk) => Effect.Effect<void>,
  ) => Effect.Effect<CellResponse, CellError | BindingProxy.BindingProxyError>
  readonly completeBinding: (input: {
    readonly operationKey: string
    readonly attempt: number
    readonly callId: string
    readonly requestDigest: string
    readonly outcome: BindingOutcome
  }) => Effect.Effect<BindingOutcome, BindingProxy.BindingProxyError>
  readonly replayBindings: (access: AccessWire) => Effect.Effect<void, BindingProxy.BindingProxyError>
}

export const make: (options: Options) => Effect.Effect<Interface, never, Crypto.Crypto | Scope.Scope> = Effect.fn(
  "HostedKernel.make",
)(function* (options) {
  const services = yield* Effect.context<Crypto.Crypto | Scope.Scope>()
  const current = yield* Ref.make<Runtime | undefined>(undefined)
  const initialization = yield* Semaphore.make(1)
  const runtime = (request: CellRequest) =>
    initialization.withPermits(1)(
      Effect.gen(function* () {
        const known = yield* Ref.get(current)
        if (known !== undefined) {
          if (known.digest !== request.bindings.digest)
            return yield* BindingProxy.BindingProxyError.make({
              message: "cell binding manifest changed during the executor session",
            })
          return known
        }
        const proxy = yield* BindingProxy.make({ manifest: request.bindings, transport: { send: options.sendBinding } })
        const kernelContext = yield* Layer.build(
          kernelCellLayer({
            workspace: options.workspacePath,
            workspaceDigest: options.workspaceIdentity,
            dataRoot: options.dataRoot,
            runtimeVersion: process.versions.bun,
            trustMode: "trusted-local",
            servers: [],
            registry: BindingProxy.layer(proxy.registry),
          }).pipe(Layer.provide(BunServices.layer)),
        )
        const executor = Context.get(kernelContext, CellExecutor)
        const cellsContext = yield* Layer.build(
          cellsLayer({
            workspaceId: options.workspaceIdentity,
            read: options.read,
            write: options.write,
            execute: (cell, output) =>
              proxy.enter(cell).pipe(
                Effect.andThen(
                  Effect.raceFirst(
                    executor.execute({
                      sessionId: cell.sessionId,
                      cellId: cell.toolCallId,
                      code: cell.code,
                      emit: (event) =>
                        event._tag === "Stdout" || event._tag === "Stderr"
                          ? output({ stream: event._tag === "Stdout" ? "stdout" : "stderr", text: event.text })
                          : Effect.void,
                    }),
                    Effect.raceFirst(
                      proxy.suspended(cell).pipe(Effect.map((token): CellResponse => ({ _tag: "Suspend", token }))),
                      proxy.unknown(cell).pipe(
                        Effect.map(
                          (message): CellResponse => ({
                            _tag: "DomainFailure",
                            failure: { kind: "unknown", message },
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
                Effect.ensuring(proxy.leave(cell)),
                Effect.mapError(() =>
                  CellError.make({ kind: "execution", message: "Remote cell binding authority failed" }),
                ),
              ),
          }),
        )
        const created = {
          digest: request.bindings.digest,
          cells: Context.get(cellsContext, Cells),
          proxy,
        }
        yield* Ref.set(current, created)
        return created
      }),
    )
  const execute: Interface["execute"] = (request, output) =>
    runtime(request).pipe(
      Effect.flatMap((hosted) => hosted.cells.execute(request, output)),
      Effect.provideContext(services),
    )
  const completeBinding: Interface["completeBinding"] = (input) =>
    Ref.get(current).pipe(
      Effect.flatMap((hosted) =>
        hosted === undefined
          ? Effect.fail(BindingProxy.BindingProxyError.make({ message: "binding result has no active kernel" }))
          : hosted.proxy.complete(input),
      ),
    )
  const replayBindings: Interface["replayBindings"] = (access) =>
    Ref.get(current).pipe(
      Effect.flatMap((hosted) => (hosted === undefined ? Effect.void : hosted.proxy.replay(access))),
    )
  return { execute, completeBinding, replayBindings } satisfies Interface
})
