import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as HostedObservability from "@rika/product/hosted-observability"
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
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
import * as Operations from "../protocol/operations"
import { NativeToolService, nativeToolLayer } from "./machinery/native-tool"
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
import { type CheckpointRestore, type WorkspaceSeedRestore, ExecutorMessage, SessionWire } from "../protocol/messages"
import { directoryVisibleTo, inspectWorkspaceCapabilities } from "../workspace/capabilities"
import { mutableExecutionEnvironment } from "./execution-environment"
import { HostError } from "./error"
import { hostIdentity, type Identity } from "./identity"
import { sessionStore } from "./persistence"
import { preparation } from "./preparation"
import type { PhaseGrant } from "./dispatch-pty-workspace"
import { connection } from "./connection"
import { program as hostProgram } from "./program"

export { HostError } from "./error"
export { sessionStore, type SessionStore } from "./persistence"

const { configuration, executorIdentity, restores, workspaceRoot, workspaceUser } = hostIdentity
const { sameFence } = preparation
const { applyGrant, connect, dispatchPty, dispatchWorkspace } = connection
const { receiveBootstrap, statePersistence } = hostProgram
const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))

export const testing = {
  applyPhaseGrant: applyGrant,
  dispatchPty,
  dispatchWorkspace,
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
    const { readNativeTool, writeNativeTool } = statePersistence(environmentIdentity.stateDirectory, crypto, fileSystem)
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
        const nativeToolRuntimeDigest = Encoding.encodeHex(
          yield* crypto.digest("SHA-256", new TextEncoder().encode("rika-native-tools-v1")).pipe(Effect.orDie),
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
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const inspectCapabilities = inspectWorkspaceCapabilities({
          target: config.fence.target,
          workspacePath: root,
          // The workspace parent is readable only by its owner; probe as that user when a direct stat fails.
          workspaceVisible: directoryVisibleTo({ spawner, user: workspaceUser, path: root }),
          nativeTools: true,
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
            nativeTools: capabilities.nativeTools,
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
        const hostScope = yield* Effect.scope
        const makeNativeTool = yield* Effect.cached(
          Layer.buildWithScope(
            nativeToolLayer({
              workspace: root,
              workspaceUser,
              environment: executionEnvironment,
              read: readNativeTool,
              write: writeNativeTool,
            }),
            hostScope,
          ).pipe(Effect.map((context) => Context.get(context, NativeToolService))),
        )
        const quiesced = yield* Ref.make(false)
        const ptyDelivery = yield* Semaphore.make(1)
        const grants = yield* Ref.make(new Map<string, PhaseGrant>())
        const environmentAccess = yield* Semaphore.make(1)
        const redactedValues = new Set<string>()
        const operationLifecycle = yield* Operations.make({
          access: executorRuntime.access.pipe(
            Effect.mapError((error) => Operations.OperationError.make({ kind: "execution", message: error.message })),
          ),
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
          machine: {
            execute: (input) =>
              Effect.gen(function* () {
                if (yield* Ref.get(quiesced))
                  return yield* Operations.OperationError.make({
                    kind: "authorization",
                    message: "Native tool admission is closed while the executor is quiesced",
                  })
                const phase = (yield* Ref.get(grants)).get(input.operationKey)
                if (phase === undefined)
                  return yield* Operations.OperationError.make({
                    kind: "authorization",
                    message: "Native tool request has no runtime authorization",
                  })
                yield* Ref.update(grants, (current) => {
                  const next = new Map(current)
                  next.delete(input.operationKey)
                  return next
                })
                return yield* environmentAccess
                  .withPermits(1)(
                    Effect.sync(() => environment.replace(phase.values)).pipe(
                      Effect.andThen(
                        Effect.flatMap(makeNativeTool, (nativeTool) =>
                          nativeTool.execute({
                            machineId: input.machineId,
                            requestDigest: input.requestDigest,
                            request: input.request,
                          }),
                        ),
                      ),
                    ),
                  )
                  .pipe(
                    Effect.mapError((error) =>
                      Operations.OperationError.make({ kind: "execution", message: error.message }),
                    ),
                  )
              }),
            cancel: (input) =>
              Effect.flatMap(makeNativeTool, (nativeTool) => nativeTool.cancel(input)).pipe(
                Effect.mapError((error) =>
                  Operations.OperationError.make({ kind: "execution", message: error.message }),
                ),
              ),
          },
        })
        return yield* Effect.scoped(
          connect({
            config,
            nativeToolRuntimeDigest,
            identity,
            seed,
            restore,
            store,
            quiesced,
            operationLifecycle,
            inspectCapabilities,
            ptyDelivery,
            activeWriter,
            grants,
            executionEnvironment,
            environmentAccess,
            redactedValues,
            connected,
          }),
        ).pipe(
          Effect.provide(Context.merge(Context.merge(runtimeContext, ptyContext), workspaceContext)),
          Effect.catchCause((cause) => {
            const permanent = Cause.findErrorOption(cause).pipe(
              Option.filter(Schema.is(HostError)),
              Option.filter((error) => error.permanent === true),
            )
            if (Option.isSome(permanent))
              return Effect.logWarning("executor-host.connection.rejected", {
                "rika.assignment.id": identity.assignmentId,
                "rika.failure.message": permanent.value.message,
              }).pipe(Effect.andThen(Effect.fail(permanent.value)))
            return Effect.logWarning("executor-host.connection.retry", {
              "rika.assignment.id": identity.assignmentId,
              "rika.failure.message": String(Cause.squash(cause)),
            }).pipe(Effect.andThen(Effect.sleep("1 second")))
          }),
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
