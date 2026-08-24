import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer as kernelCellLayer } from "@rika/kernel/cell-executor"
import { Context, Crypto, Effect, Layer, Ref, Scope, Semaphore } from "effect"
import * as BindingProxy from "./binding-proxy"
import { CellError, Cells, layer as cellsLayer, type OutputChunk, type State as CellState } from "./cells"
import type { AccessWire, BindingOutcome, CellRequest, CellResponse } from "./protocol"

interface Runtime {
  readonly digest: string
  readonly executor: CellExecutor["Service"]
  readonly proxy: BindingProxy.Interface
}

export interface Options {
  readonly workspaceIdentity: string
  readonly workspacePath: string
  readonly dataRoot: string
  readonly bindingContractDigest?: Ref.Ref<string | undefined>
  readonly read: (operationKey: string) => Effect.Effect<CellState | undefined, CellError>
  readonly write: (operationKey: string, state: CellState) => Effect.Effect<void, CellError>
  readonly sendBinding: BindingProxy.Transport["send"]
  readonly environment?: Readonly<Record<string, string>>
}

export interface Interface {
  readonly admit: (request: CellRequest) => Effect.Effect<void, CellError | BindingProxy.BindingProxyError>
  readonly execute: (
    request: CellRequest,
    output: (chunk: OutputChunk) => Effect.Effect<void>,
  ) => Effect.Effect<CellResponse, CellError | BindingProxy.BindingProxyError>
  readonly cancel: (operationKey: string, attempt: number) => Effect.Effect<CellResponse, CellError>
  readonly completeBinding: (input: {
    readonly operationKey: string
    readonly attempt: number
    readonly callId: string
    readonly requestDigest: string
    readonly outcome: BindingOutcome
  }) => Effect.Effect<BindingOutcome, BindingProxy.BindingProxyError>
  readonly replayBindings: (access: AccessWire) => Effect.Effect<void, BindingProxy.BindingProxyError>
  readonly restart: (sessionId: string) => Effect.Effect<void>
}

export const make: (options: Options) => Effect.Effect<Interface, never, Crypto.Crypto | Scope.Scope> = Effect.fn(
  "HostedKernel.make",
)(function* (options) {
  const services = yield* Effect.context<Crypto.Crypto | Scope.Scope>()
  const current = yield* Ref.make<Runtime | undefined>(undefined)
  const admittedDigest = yield* Ref.make<string | undefined>(undefined)
  const initialization = yield* Semaphore.make(1)
  const authorize = (request: CellRequest) =>
    Effect.gen(function* () {
      if (request.workspaceId !== options.workspaceIdentity)
        return yield* CellError.make({ kind: "workspace", message: "Cell workspace does not match this executor" })
      if (options.bindingContractDigest !== undefined) {
        const bindingContractDigest = yield* Ref.get(options.bindingContractDigest)
        if (bindingContractDigest === undefined || bindingContractDigest !== request.bindings.digest)
          return yield* BindingProxy.BindingProxyError.make({
            message: "cell binding manifest does not match the prepared binding contract",
          })
      }
      const digest = yield* Ref.get(admittedDigest)
      if (digest !== undefined && digest !== request.bindings.digest)
        return yield* BindingProxy.BindingProxyError.make({
          message: "cell binding manifest changed during the executor session",
        })
      if (digest === undefined) yield* Ref.set(admittedDigest, request.bindings.digest)
    })
  const runtime = (request: CellRequest): Effect.Effect<Runtime, BindingProxy.BindingProxyError | CellError> =>
    initialization
      .withPermits(1)(
        Effect.gen(function* () {
          yield* authorize(request)
          const known = yield* Ref.get(current)
          if (known !== undefined) return known
          const proxy = yield* BindingProxy.make({
            manifest: request.bindings,
            transport: { send: options.sendBinding },
          })
          const kernelContext = yield* Layer.build(
            kernelCellLayer({
              workspace: options.workspacePath,
              workspaceDigest: options.workspaceIdentity,
              dataRoot: options.dataRoot,
              runtimeVersion: process.versions.bun,
              trustMode: "trusted-local",
              servers: [],
              registry: BindingProxy.layer(proxy.registry),
              environment: options.environment ?? {},
            }).pipe(Layer.provide(BunServices.layer)),
          )
          const executor = Context.get(kernelContext, CellExecutor)
          const created = {
            digest: request.bindings.digest,
            executor,
            proxy,
          }
          yield* Ref.set(current, created)
          return created
        }),
      )
      .pipe(Effect.provideContext(services))
  const cellsContext = yield* Layer.build(
    cellsLayer({
      workspaceId: options.workspaceIdentity,
      read: options.read,
      write: options.write,
      execute: (cell, output) =>
        runtime(cell).pipe(
          Effect.flatMap(({ executor, proxy }) =>
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
            ),
          ),
          Effect.mapError(() => CellError.make({ kind: "execution", message: "Remote cell binding authority failed" })),
        ),
    }),
  )
  const cells = Context.get(cellsContext, Cells)
  const execute: Interface["execute"] = (request, output) =>
    initialization
      .withPermits(1)(authorize(request))
      .pipe(Effect.andThen(cells.execute(request, output)), Effect.provideContext(services))
  const admit: Interface["admit"] = (request) =>
    initialization
      .withPermits(1)(authorize(request))
      .pipe(Effect.andThen(cells.admit(request)), Effect.provideContext(services))
  const cancel: Interface["cancel"] = (operationKey, attempt) => cells.cancel(operationKey, attempt)
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
  const restart: Interface["restart"] = (sessionId) =>
    Ref.get(current).pipe(
      Effect.flatMap((hosted) => (hosted === undefined ? Effect.void : hosted.executor.restart(sessionId))),
    )
  return { admit, execute, cancel, completeBinding, replayBindings, restart } satisfies Interface
})
