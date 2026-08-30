import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import * as HostedObservability from "@rika/product/hosted-observability"
import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { BindingProxyError } from "../protocol/binding-proxy"
import { CellError } from "../protocol/cells"
import * as Operations from "../protocol/operations"
import * as HostedKernel from "./kernel"
import { Machine, workspaceLayer as machineLayer } from "./machinery/machine"
import {
  Manager as PtyManager,
  driverLayer as ptyDriverLayer,
  layer as ptyLayer,
  liveCapabilities,
  repositoryLayer as ptyRepositoryLayer,
} from "./terminal/pty"
import {
  driverLayer as repositoryServiceDriverLayer,
  layer as repositoryServicesLayer,
  repositoryLayer as repositoryServiceRepositoryLayer,
} from "../workspace/repositories"
import { Runtime, layer as runtimeLayer } from "./runtime"
import { layer as workspaceFilesLayer } from "../workspace/files"
import {
  type CheckpointRestore,
  type WorkspaceSeedRestore,
  ExecutorMessage,
  SessionWire,
  type CellRequest,
} from "../protocol/messages"
import { inspectWorkspaceCapabilities } from "../workspace/capabilities"
import { mutableExecutionEnvironment } from "./execution-environment"
import { HostError } from "./error"
import { hostIdentity, type Identity } from "./identity"
import { persistence, sessionStore } from "./persistence"
import { preparation } from "./preparation"
import type { PhaseGrant } from "./dispatch-pty-workspace"
import { connection } from "./connection"
import { program as hostProgram } from "./program"

export { HostError } from "./error"
export { sessionStore, type OperationReceiptStore, type SessionStore } from "./persistence"

const { configuration, executorIdentity, restores, workspaceRoot, workspaceUser } = hostIdentity
const { operationReceiptStore } = persistence
const { sameFence } = preparation
const { applyGrant, connect, dispatchPty, dispatchWorkspace } = connection
const { receiveBootstrap, statePersistence } = hostProgram
const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const cellCorrelation = (request: CellRequest) => ({
  threadId: request.threadId,
  turnId: request.turnId,
  runId: request.runId,
  operationId: request.operationKey,
  cellId: request.toolCallId,
})

export const testing = {
  applyPhaseGrant: applyGrant,
  dispatchPty,
  dispatchWorkspace,
  operationReceiptStore,
  receiveBootstrap,
  sameFence,
} as const

const host = Effect.scoped(
  Effect.gen(function* () {
    const environmentIdentity = yield* executorIdentity
    const root = yield* workspaceRoot
    const store = yield* sessionStore(environmentIdentity.stateDirectory)
    const persisted = yield* store.load
    const matchingSession =
      Option.isSome(persisted) && restores(environmentIdentity, persisted.value) ? persisted.value : undefined
    if (Option.isSome(persisted) && matchingSession === undefined) {
      const restoreCorrelation =
        environmentIdentity.templateBuildId === null
          ? { assignmentId: environmentIdentity.assignmentId, sandboxId: environmentIdentity.instanceId }
          : {
              assignmentId: environmentIdentity.assignmentId,
              sandboxId: environmentIdentity.instanceId,
              buildId: environmentIdentity.templateBuildId,
            }
      yield* HostedObservability.health("restore_failure", restoreCorrelation)
    }
    const crypto = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const { readState, writeState, readMachine, writeMachine } = statePersistence(
      environmentIdentity.stateDirectory,
      crypto,
      fileSystem,
    )
    const run = (
      identity: Identity,
      bootstrapToken: Redacted.Redacted<string>,
      restoredSession: SessionWire | undefined,
      seed: WorkspaceSeedRestore | null,
      restore: CheckpointRestore | null,
      connected: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const config = yield* configuration(identity, bootstrapToken, restoredSession)
        const kernelOptions = {
          workspace: root,
          workspaceDigest: config.workspaceId,
          dataRoot: config.stateDirectory,
          runtimeVersion: process.versions.bun,
          trustMode: "trusted-local" as const,
          servers: [],
        }
        const kernelProfileDigest = KernelProfileRegistration.digest(
          KernelProfileRegistration.make({ ...kernelOptions, environment: { servers: kernelOptions.servers } }),
        )
        const bindingContractDigest = yield* Ref.make<string | undefined>(undefined)
        const receipts = yield* operationReceiptStore(
          config.stateDirectory,
          config.fence.assignmentId,
          config.fence.assignmentGeneration,
        )
        const ptyContext = yield* Layer.build(
          ptyLayer.pipe(
            Layer.provide(
              Layer.merge(
                ptyDriverLayer({
                  fence: config.fence,
                  workspaceRoot: root,
                  workspaceUser,
                }),
                ptyRepositoryLayer({
                  stateDirectory: config.stateDirectory,
                  fence: config.fence,
                }),
              ),
            ),
          ),
        ).pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const workspaceContext = yield* Layer.build(
          Layer.merge(
            workspaceFilesLayer(root),
            repositoryServicesLayer.pipe(
              Layer.provide(
                Layer.merge(
                  repositoryServiceDriverLayer({ workspaceRoot: root, workspaceUser }),
                  repositoryServiceRepositoryLayer({ stateDirectory: config.stateDirectory, fence: config.fence }),
                ),
              ),
            ),
          ),
        ).pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const capabilities = yield* liveCapabilities(workspaceUser)
        const pty = Context.get(ptyContext, PtyManager)
        yield* pty.disconnectAll.pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const ptyCursor = yield* pty.cursor.pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const ptyReady = config.fence.target === "orb" && capabilities.pty
        const inspectCapabilities = inspectWorkspaceCapabilities({
          target: config.fence.target,
          workspacePath: root,
          typescriptKernel: true,
          pty: ptyReady,
          browser: capabilities.browser,
          services: capabilities.services,
        })
        const workspaceCapabilities = yield* inspectCapabilities
        const runtimeOptions = {
          fence: config.fence,
          bootstrapToken: config.bootstrapToken,
          templateBuildId: config.templateBuildId,
          capabilities: {
            cells: capabilities.cells,
            checkpoints: capabilities.checkpoints,
            pty: ptyReady,
          },
          workspaceCapabilities,
          cursors: { command: 0, event: 0, pty: ptyCursor },
          latestCheckpointId: null,
        }
        const runtime = runtimeLayer(
          config.restoredSession === undefined
            ? runtimeOptions
            : { ...runtimeOptions, restoredSession: config.restoredSession },
        )
        const environment = mutableExecutionEnvironment()
        const executionEnvironment = environment.values
        const runtimeContext = yield* Layer.build(runtime).pipe(
          Effect.mapError((error) => HostError.make({ message: error.message })),
        )
        const executorRuntime = Context.get(runtimeContext, Runtime)
        const activeWriter = yield* Ref.make<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>(
          undefined,
        )
        const cells = yield* HostedKernel.make({
          workspaceIdentity: config.workspaceId,
          workspacePath: root,
          dataRoot: config.stateDirectory,
          bindingContractDigest,
          read: readState,
          write: writeState,
          environment: executionEnvironment,
          sendBinding: (message) =>
            Effect.gen(function* () {
              const writer = yield* Ref.get(activeWriter)
              if (writer === undefined)
                return yield* BindingProxyError.make({ message: "Executor binding transport is unavailable" })
              const currentAccess = yield* executorRuntime.access.pipe(
                Effect.mapError(() => BindingProxyError.make({ message: "Executor binding access is unavailable" })),
              )
              yield* writer(encodeExecutorMessage({ _tag: "BindingInvoke", ...message, access: currentAccess })).pipe(
                Effect.mapError(() => BindingProxyError.make({ message: "Could not write executor binding request" })),
              )
            }),
        })
        const hostScope = yield* Effect.scope
        const makeMachine = yield* Effect.cached(
          Layer.buildWithScope(
            machineLayer({
              workspace: root,
              workspaceUser,
              environment: executionEnvironment,
              read: readMachine,
              write: writeMachine,
            }),
            hostScope,
          ).pipe(Effect.map((context) => Context.get(context, Machine))),
        )
        const frames = yield* Ref.make(yield* receipts.load)
        const quiesced = yield* Ref.make(false)
        const ptyDelivery = yield* Semaphore.make(1)
        const grants = yield* Ref.make(new Map<string, PhaseGrant>())
        const appliedEnvironment = yield* Ref.make(new Map<string, string>())
        const environmentAccess = yield* Semaphore.make(1)
        const redactedValues = new Set<string>()
        const operationFailure = (error: CellError | BindingProxyError) =>
          Operations.OperationError.make({
            kind: error._tag === "CellError" ? error.kind : "execution",
            message: error.message,
          })
        const operationLifecycle = yield* Operations.make({
          access: executorRuntime.access.pipe(
            Effect.mapError((error) => Operations.OperationError.make({ kind: "execution", message: error.message })),
          ),
          receipts: {
            current: Ref.get(frames),
            commit: (next) =>
              receipts.save(next).pipe(
                Effect.andThen(Ref.set(frames, next)),
                Effect.mapError((error) =>
                  Operations.OperationError.make({ kind: "persistence", message: error.message }),
                ),
              ),
          },
          emit: (event) =>
            Ref.get(activeWriter).pipe(
              Effect.flatMap((writer) =>
                writer === undefined
                  ? Effect.fail(
                      Operations.OperationError.make({
                        kind: "transport",
                        message: "Executor operation transport is unavailable",
                      }),
                    )
                  : writer(encodeExecutorMessage(event)).pipe(
                      Effect.mapError(() =>
                        Operations.OperationError.make({
                          kind: "transport",
                          message: "Could not write executor operation",
                        }),
                      ),
                    ),
              ),
            ),
          cell: {
            prepare: (request) =>
              Effect.gen(function* () {
                if (yield* Ref.get(quiesced))
                  return yield* Operations.OperationError.make({
                    kind: "authorization",
                    message: "Cell admission is closed while the executor is quiesced",
                  })
                const phase = (yield* Ref.get(grants)).get(request.operationKey)
                if (phase === undefined)
                  return yield* Operations.OperationError.make({
                    kind: "authorization",
                    message: "Cell request has no runtime authorization",
                  })
                yield* Ref.update(grants, (current) => {
                  const next = new Map(current)
                  next.delete(request.operationKey)
                  return next
                })
                const secrets = phase.redactedNames.flatMap((name) => {
                  const value = phase.values[name]
                  return value === undefined ? [] : [value]
                })
                return {
                  secrets,
                  execute: (output: Parameters<Operations.PreparedCell["execute"]>[0]) =>
                    HostedObservability.observe(
                      "cell_execution",
                      cellCorrelation(request),
                      environmentAccess.withPermits(1)(
                        Effect.gen(function* () {
                          const applied = yield* Ref.get(appliedEnvironment)
                          const previousDigest = applied.get(request.sessionId)
                          if (previousDigest !== phase.digest) {
                            environment.replace(phase.values)
                            if (previousDigest !== undefined) yield* cells.restart(request.sessionId)
                            yield* Ref.set(appliedEnvironment, new Map(applied).set(request.sessionId, phase.digest))
                          }
                          return yield* cells.execute(request, output)
                        }),
                      ),
                      (response) => (response._tag === "DomainFailure" ? "failure" : "success"),
                    ).pipe(Effect.mapError(operationFailure)),
                }
              }),
            admit: (request) => cells.admit(request).pipe(Effect.mapError(operationFailure)),
            cancel: (operationKey, attempt) =>
              cells
                .cancel(operationKey, attempt)
                .pipe(
                  Effect.mapError((error) =>
                    Operations.OperationError.make({ kind: error.kind, message: error.message }),
                  ),
                ),
            replayBindings: (access) => cells.replayBindings(access).pipe(Effect.mapError(operationFailure)),
          },
          machine: {
            execute: (input) =>
              Effect.flatMap(makeMachine, (machine) => machine.execute(input)).pipe(
                Effect.mapError((error) =>
                  Operations.OperationError.make({ kind: "execution", message: error.message }),
                ),
              ),
          },
        })
        return yield* Effect.scoped(
          connect({
            config,
            kernelProfileDigest,
            bindingContractDigest,
            identity,
            seed,
            restore,
            store,
            quiesced,
            cells,
            operationLifecycle,
            inspectCapabilities,
            ptyDelivery,
            activeWriter,
            grants,
            executionEnvironment,
            appliedEnvironment,
            environmentAccess,
            redactedValues,
            connected,
          }),
        ).pipe(
          Effect.provide(Context.merge(Context.merge(runtimeContext, ptyContext), workspaceContext)),
          Effect.catchCause(() => Effect.sleep("1 second")),
          Effect.forever,
        )
      }).pipe(
        Effect.tapError(() => {
          const correlation =
            identity.templateBuildId === null
              ? { assignmentId: identity.assignmentId, sandboxId: identity.instanceId }
              : {
                  assignmentId: identity.assignmentId,
                  sandboxId: identity.instanceId,
                  buildId: identity.templateBuildId,
                }
          return HostedObservability.health(
            restoredSession === undefined ? "setup_failure" : "restore_failure",
            correlation,
          )
        }),
      )
    const monitor = (
      running: Fiber.Fiber<never, HostError>,
    ): Effect.Effect<
      never,
      HostError,
      | ChildProcessSpawner.ChildProcessSpawner
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | Socket.WebSocketConstructor
      | import("effect").Scope.Scope
    > =>
      Effect.gen(function* () {
        const replacement = yield* Effect.scoped(receiveBootstrap)
        const admitted = yield* Deferred.make<void>()
        const candidate = yield* Effect.forkScoped(
          run(
            replacement.identity,
            replacement.credential,
            undefined,
            replacement.seed,
            replacement.restore,
            Deferred.succeed(admitted, undefined).pipe(Effect.asVoid),
          ),
        )
        const accepted = yield* Deferred.await(admitted).pipe(Effect.timeoutOption("30 seconds"))
        if (Option.isNone(accepted)) {
          yield* Fiber.interrupt(candidate)
          return yield* monitor(running)
        }
        yield* Fiber.interrupt(running)
        return yield* monitor(candidate)
      })
    const supervise = (
      identity: Identity,
      bootstrapToken: Redacted.Redacted<string>,
      restoredSession: SessionWire | undefined,
      seed: WorkspaceSeedRestore | null,
      restore: CheckpointRestore | null,
    ): Effect.Effect<
      never,
      HostError,
      | ChildProcessSpawner.ChildProcessSpawner
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | Socket.WebSocketConstructor
      | import("effect").Scope.Scope
    > =>
      Effect.gen(function* () {
        const running = yield* Effect.forkScoped(run(identity, bootstrapToken, restoredSession, seed, restore))
        return yield* monitor(running)
      })
    if (matchingSession === undefined) {
      const bootstrap = yield* Effect.scoped(receiveBootstrap)
      return yield* supervise(bootstrap.identity, bootstrap.credential, undefined, bootstrap.seed, bootstrap.restore)
    }
    const selected = yield* Deferred.make<"bootstrap" | "reconnect">()
    const fresh = yield* Effect.forkScoped(
      Effect.scoped(receiveBootstrap).pipe(
        Effect.flatMap((bootstrap) =>
          run(
            bootstrap.identity,
            bootstrap.credential,
            undefined,
            bootstrap.seed,
            bootstrap.restore,
            Deferred.succeed(selected, "bootstrap").pipe(Effect.asVoid),
          ),
        ),
      ),
    )
    const restored = yield* Effect.forkScoped(
      run(
        environmentIdentity,
        Redacted.make("", { label: "executor-bootstrap-not-required" }),
        matchingSession,
        null,
        null,
        Deferred.succeed(selected, "reconnect").pipe(Effect.asVoid),
      ),
    )
    const winner = yield* Deferred.await(selected)
    const running = winner === "bootstrap" ? fresh : restored
    yield* Fiber.interrupt(winner === "bootstrap" ? restored : fresh)
    return yield* monitor(running)
  }),
)

const program = Effect.scoped(
  Effect.flatMap(Layer.build(Layer.merge(BunSocket.layerWebSocketConstructor, BunServices.layer)), (context) =>
    Effect.provide(host, context),
  ),
)
if (import.meta.main) BunRuntime.runMain(program)
