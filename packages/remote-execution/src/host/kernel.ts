import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer as kernelCellLayer } from "@rika/kernel/cell-executor"
import type { Cell } from "generalist/repl"
import { Clock, Context, Crypto, Effect, Layer, Ref, Scope, Semaphore } from "effect"
import * as BindingProxy from "../protocol/binding-proxy"
import { runnerBoundary, runnerEvent, runnerWarning, type RunnerAnnotations } from "../protocol/telemetry"
import { CellError, Cells, layer as cellsLayer, type OutputChunk, type State as CellState } from "../protocol/cells"
import type { AccessWire, BindingOutcome, CellRequest, CellResponse } from "../protocol/messages"

const KernelNoProgressCheckIntervalMillis = 15_000
const KernelNoProgressWarnAfterMillis = 30_000

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

/**
 * Forwards kernel cell events: stdout/stderr reach the caller, and the lifecycle events that were
 * previously dropped (host binding calls, kernel starts/restarts, state loss) become runner
 * diagnostics so a stalled or rebooted kernel is visible on the machine instead of silent.
 */
const forwardCellEvent = (
  event: Cell.CellEvent,
  output: (chunk: OutputChunk) => Effect.Effect<void>,
  correlation: RunnerAnnotations,
): Effect.Effect<void> => {
  switch (event._tag) {
    case "Stdout":
      return output({ stream: "stdout", text: event.text })
    case "Stderr":
      return output({ stream: "stderr", text: event.text })
    case "HostCall": {
      const base: RunnerAnnotations = {
        ...correlation,
        "rika.binding.module": event.module,
        "rika.binding.operation": event.operation,
        "rika.host.status": event.status,
      }
      const annotations: RunnerAnnotations =
        event.durationMillis === undefined ? base : { ...base, "rika.duration.millis": event.durationMillis }
      return runnerEvent("runner.kernel.host_call", annotations)
    }
    case "KernelStarting":
      return runnerEvent("runner.kernel.starting", { ...correlation, "rika.kernel.epoch": event.epoch })
    case "KernelRestarted":
      return runnerWarning("runner.kernel.restarted", {
        ...correlation,
        "rika.kernel.epoch": event.epoch,
        "rika.kernel.restart_reason": event.reason,
      })
    case "StateLost":
      return runnerWarning("runner.kernel.state_lost", {
        ...correlation,
        "rika.kernel.epoch": event.epoch,
        "rika.state_lost.reason": event.reason,
      })
    case "StateRestored":
      return runnerEvent("runner.kernel.state_restored", { ...correlation, "rika.kernel.epoch": event.epoch })
    default:
      return Effect.void
  }
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
          yield* runnerEvent("runner.kernel.runtime_created", {
            "rika.operation.key": request.operationKey,
          })
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
                runnerBoundary(
                  Effect.gen(function* () {
                    const correlation: RunnerAnnotations = {
                      "rika.session.id": cell.sessionId,
                      "rika.cell.id": cell.toolCallId,
                      "rika.operation.key": cell.operationKey,
                      "rika.operation.attempt": cell.attempt,
                    }
                    const lastActivity = yield* Ref.make(yield* Clock.currentTimeMillis)
                    const watchdog = Effect.gen(function* () {
                      yield* Effect.sleep(KernelNoProgressCheckIntervalMillis)
                      const now = yield* Clock.currentTimeMillis
                      const silentMillis = now - (yield* Ref.get(lastActivity))
                      if (silentMillis >= KernelNoProgressWarnAfterMillis)
                        yield* runnerWarning("runner.kernel.cell.no_progress", {
                          ...correlation,
                          "rika.silent.millis": silentMillis,
                        }).pipe(Effect.andThen(Ref.set(lastActivity, now)))
                    }).pipe(Effect.forever)
                    return yield* Effect.raceFirst(
                      Effect.raceFirst(
                        executor.execute({
                          sessionId: cell.sessionId,
                          cellId: cell.toolCallId,
                          code: cell.code,
                          emit: (event) =>
                            Clock.currentTimeMillis.pipe(
                              Effect.flatMap((now) => Ref.set(lastActivity, now)),
                              Effect.andThen(forwardCellEvent(event, output, correlation)),
                            ),
                        }),
                        watchdog,
                      ),
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
                    )
                  }),
                  "runner.kernel.execute",
                  {
                    "rika.session.id": cell.sessionId,
                    "rika.cell.id": cell.toolCallId,
                    "rika.operation.key": cell.operationKey,
                    "rika.operation.attempt": cell.attempt,
                  },
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
