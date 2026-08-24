import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import * as HostedObservability from "@rika/product/hosted-observability"
import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import {
  Cause,
  Config as EffectConfig,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Queue,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { BindingProxyError } from "../protocol/binding-proxy"
import { CellError, State as CellState, terminalOutcome, type State as CellStateValue } from "../protocol/cells"
import * as HostedKernel from "./kernel"
import {
  Machine,
  MachineError,
  State as MachineState,
  workspaceLayer as machineLayer,
  type State as MachineStateValue,
} from "./machine"
import {
  Manager as PtyManager,
  driverLayer as ptyDriverLayer,
  layer as ptyLayer,
  liveCapabilities,
  repositoryLayer as ptyRepositoryLayer,
  type Connection as PtyConnection,
} from "./pty"
import {
  RepositoryServices,
  driverLayer as repositoryServiceDriverLayer,
  layer as repositoryServicesLayer,
  repositoryLayer as repositoryServiceRepositoryLayer,
} from "../workspace/repositories"
import { Runtime, layer as runtimeLayer } from "./runtime"
import {
  prepare as prepareWorkspace,
  pushApprovedBranch,
  RemoteRepositoryRoot,
  WorkspaceError,
  type KernelIdentity,
} from "../workspace/service"
import { WorkspaceFiles, layer as workspaceFilesLayer } from "../workspace/files"
import {
  ApiMessage,
  type ApiMessage as IncomingMessage,
  CellLifecycleFrame,
  CellResponse as CellResponseSchema,
  ExecutorBootstrapWire,
  type ExecutorBootstrapIdentity,
  type CheckpointRestore,
  type Fence,
  ExecutorMessage,
  type RepositoryCheckoutWire,
  SessionWire,
  Target,
  type CellRequest,
  type CellResponse,
} from "../protocol/messages"
import { inspectWorkspaceCapabilities } from "../workspace/capabilities"
import { createArchive, encodeArchive } from "../workspace/archive"

interface Config {
  readonly fence: Fence
  readonly templateBuildId: string | null
  readonly apiUrl: string
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly workspaceId: string
  readonly stateDirectory: string
  readonly wakeId: string
  readonly restoredSession?: SessionWire
}

interface Identity extends ExecutorBootstrapIdentity {
  readonly stateDirectory: string
}

interface Bootstrap {
  readonly credential: Redacted.Redacted<string>
  readonly identity: Identity
  readonly restore: CheckpointRestore | null
}

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const decodeBootstrap = Schema.decodeUnknownEffect(ExecutorBootstrapWire)
const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const decodeCellState = Schema.decodeUnknownEffect(Schema.fromJsonString(CellState))
const encodeCellState = Schema.encodeEffect(Schema.fromJsonString(CellState))
const decodeMachineState = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineState))
const encodeMachineState = Schema.encodeEffect(Schema.fromJsonString(MachineState))
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionWire))
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(SessionWire))
const OperationReceiptSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  receipts: Schema.Array(
    Schema.Struct({
      operationKey: Schema.String.check(Schema.isMinLength(1)),
      frames: Schema.Array(CellLifecycleFrame),
    }),
  ),
})
const decodeOperationReceipts = Schema.decodeUnknownEffect(Schema.fromJsonString(OperationReceiptSnapshot))
const encodeOperationReceipts = Schema.encodeEffect(Schema.fromJsonString(OperationReceiptSnapshot))
const executorStateDirectory = "/var/lib/rika-executor"
const directoryMode = 0o700
const fileMode = 0o600
const sandboxIdPath = "/run/e2b/.E2B_SANDBOX_ID"
const workspaceRootConfig = EffectConfig.string("RIKA_EXECUTOR_WORKSPACE_ROOT").pipe(
  EffectConfig.withDefault(RemoteRepositoryRoot),
)
const workspaceRoot = workspaceRootConfig.pipe(
  Effect.mapError(() => HostError.make({ message: "RIKA_EXECUTOR_WORKSPACE_ROOT is invalid" })),
)
const workspaceUser = "rika-workspace"

const cellCorrelation = (request: CellRequest) => ({
  threadId: request.threadId,
  turnId: request.turnId,
  runId: request.runId,
  operationId: request.operationKey,
  cellId: request.toolCallId,
})

const sandboxInstanceId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.readFileString(sandboxIdPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.catch(() => EffectConfig.string("E2B_SANDBOX_ID").pipe(EffectConfig.withDefault(""))),
  )
})

const stopServerAdapter = (server: ReturnType<typeof Bun.serve>) =>
  Effect.raceFirst(
    Effect.callback<void>((resume) => {
      server.stop(false).then(
        () => resume(Effect.void),
        (error) => resume(Effect.die(error)),
      )
    }),
    Effect.sleep("1 second").pipe(Effect.andThen(Effect.tryPromise(() => server.stop(true))), Effect.orDie),
  )

const required = (name: string) =>
  EffectConfig.nonEmptyString(name).pipe(Effect.mapError(() => HostError.make({ message: `${name} is required` })))

const executorIdentity = Effect.gen(function* () {
  const target = yield* Effect.flatMap(required("RIKA_EXECUTOR_TARGET"), (value) =>
    Schema.decodeUnknownEffect(Target)(value).pipe(
      Effect.mapError(() => HostError.make({ message: "RIKA_EXECUTOR_TARGET is invalid" })),
    ),
  )
  if (target !== "orb") return yield* HostError.make({ message: "Hosted executor target must be e2b" })
  const assignmentId = yield* required("RIKA_EXECUTOR_ASSIGNMENT_ID")
  const generationText = yield* required("RIKA_EXECUTOR_GENERATION")
  const assignmentGeneration = Number(generationText)
  if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 1)
    return yield* HostError.make({ message: "RIKA_EXECUTOR_GENERATION is invalid" })
  const repositoryId = yield* EffectConfig.option(EffectConfig.string("RIKA_EXECUTOR_REPOSITORY_ID"))
  const repository = Option.isNone(repositoryId)
    ? null
    : {
        repositoryId: repositoryId.value,
        owner: yield* required("RIKA_EXECUTOR_REPOSITORY_OWNER"),
        name: yield* required("RIKA_EXECUTOR_REPOSITORY_NAME"),
        commitSha: yield* required("RIKA_EXECUTOR_COMMIT_SHA"),
      }
  return {
    target,
    ownerId: yield* required("RIKA_EXECUTOR_OWNER_ID"),
    threadId: yield* required("RIKA_EXECUTOR_THREAD_ID"),
    assignmentId,
    assignmentGeneration,
    instanceId: target === "orb" ? yield* required("E2B_SANDBOX_ID") : yield* required("RIKA_EXECUTOR_INSTANCE_ID"),
    executorId: yield* required("RIKA_EXECUTOR_ID"),
    templateBuildId: yield* required("RIKA_EXECUTOR_TEMPLATE_BUILD_ID"),
    apiUrl: yield* required("RIKA_EXECUTOR_API_URL"),
    workspaceId: yield* required("RIKA_EXECUTOR_WORKSPACE_ID"),
    repository,
    lifecycle: "resume",
    environmentDigest: yield* required("RIKA_EXECUTOR_ENVIRONMENT_DIGEST"),
    setupCache: (yield* EffectConfig.string("RIKA_EXECUTOR_SETUP_CACHE").pipe(EffectConfig.withDefault("0"))) === "1",
    stateDirectory: yield* EffectConfig.string("RIKA_EXECUTOR_STATE_DIRECTORY").pipe(
      EffectConfig.withDefault(executorStateDirectory),
    ),
  } satisfies Identity
})

const restores = (identity: Identity, session: SessionWire) =>
  session.fence.target === identity.target &&
  session.fence.assignmentId === identity.assignmentId &&
  session.fence.assignmentGeneration === identity.assignmentGeneration &&
  session.fence.instanceId === identity.instanceId &&
  session.fence.executorId === `${identity.executorId}:${session.fence.processIncarnation}`

const configuration = (identity: Identity, bootstrapToken: Redacted.Redacted<string>, restoredSession?: SessionWire) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const processIncarnation =
      restoredSession === undefined
        ? yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() => HostError.make({ message: "Could not create the process incarnation" })),
          )
        : restoredSession.fence.processIncarnation
    const wakeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => HostError.make({ message: "Could not create the workspace wake identity" })),
    )
    return {
      fence: {
        target: identity.target,
        assignmentId: identity.assignmentId,
        assignmentGeneration: identity.assignmentGeneration,
        instanceId: identity.instanceId,
        executorId: `${identity.executorId}:${processIncarnation}`,
        processIncarnation,
      },
      templateBuildId: identity.templateBuildId,
      apiUrl: identity.apiUrl,
      bootstrapToken,
      workspaceId: identity.workspaceId,
      stateDirectory: identity.stateDirectory,
      wakeId,
      ...(restoredSession === undefined ? {} : { restoredSession }),
    } satisfies Config
  })

export interface SessionStore {
  readonly load: Effect.Effect<Option.Option<SessionWire>, HostError>
  readonly save: (session: SessionWire) => Effect.Effect<void, HostError>
}

export const sessionStore = (stateDirectory: string): Effect.Effect<SessionStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const filename = `${stateDirectory}/session.json`
    const restrictDirectory = fileSystem.makeDirectory(stateDirectory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(stateDirectory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor session state" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor session state" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor session state" })),
              Effect.flatMap((text) =>
                decodeSession(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor session state is invalid" })),
                  Effect.map(Option.some),
                ),
              ),
            )
          : Effect.succeedNone,
      ),
    )
    const save = Effect.fn("Host.sessionStore.save")(function* (session: SessionWire) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeSession(session).pipe(
        Effect.mapError(() => HostError.make({ message: "Could not encode executor session state" })),
      )
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor session state" })),
      )
    })
    return { load, save } satisfies SessionStore
  })

export interface OperationReceiptStore {
  readonly load: Effect.Effect<Map<string, ReadonlyArray<CellLifecycleFrame>>, HostError>
  readonly save: (frames: Map<string, ReadonlyArray<CellLifecycleFrame>>) => Effect.Effect<void, HostError>
}

const operationReceiptStore = (
  stateDirectory: string,
  assignmentId: string,
  assignmentGeneration: number,
): Effect.Effect<OperationReceiptStore, never, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    const directory = `${stateDirectory}/operation-receipts`
    const assignmentDigest = yield* crypto.digest("SHA-256", new TextEncoder().encode(assignmentId)).pipe(Effect.orDie)
    const filename = `${directory}/assignment-${Encoding.encodeHex(assignmentDigest)}-g${assignmentGeneration}.json`
    const restrictDirectory = fileSystem.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(directory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor operation receipts" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor operation receipts" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor operation receipts" })),
              Effect.flatMap((text) =>
                decodeOperationReceipts(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor operation receipts are invalid" })),
                ),
              ),
              Effect.map(
                (snapshot) =>
                  new Map(
                    snapshot.receipts.map(
                      (receipt) =>
                        [
                          `${receipt.operationKey}\u0000${receipt.frames[0]!.attribution.attempt}`,
                          receipt.frames,
                        ] as const,
                    ),
                  ),
              ),
            )
          : Effect.succeed(new Map()),
      ),
    )
    const save = Effect.fn("Host.operationReceiptStore.save")(function* (
      frames: Map<string, ReadonlyArray<CellLifecycleFrame>>,
    ) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeOperationReceipts({
        version: 1,
        receipts: [...frames.values()].map((retained) => ({
          operationKey: retained[0]!.attribution.operationKey,
          frames: retained,
        })),
      }).pipe(Effect.mapError(() => HostError.make({ message: "Could not encode executor operation receipts" })))
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor operation receipts" })),
      )
    })
    return { load, save } satisfies OperationReceiptStore
  })

const persistSession = (store: SessionStore) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const session = yield* runtime.persistedSession.pipe(
      Effect.mapError((cause) => HostError.make({ message: cause.message })),
    )
    yield* store.save(session)
  })

const waitForWelcome = (
  incoming: Queue.Queue<IncomingMessage>,
  store: SessionStore,
): Effect.Effect<void, HostError, Runtime | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
    if (message._tag === "ExecutorWelcome") {
      yield* runtime
        .welcome(message.welcome)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      yield* persistSession(store)
      return
    }
    if (message._tag === "ExecutorReconnected") {
      yield* runtime
        .reconnected(message.welcome)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      yield* persistSession(store)
      return
    }
    return yield* waitForWelcome(incoming, store)
  })

const sameFence = (left: Fence, right: Fence) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

const prepare = (
  config: Config,
  kernelProfileDigest: string,
  bindingContractDigest: Ref.Ref<string | undefined>,
  identity: Identity,
  restore: CheckpointRestore | null,
  incoming: Queue.Queue<IncomingMessage>,
  credentials: Queue.Queue<Extract<IncomingMessage, { readonly _tag: "RepositoryCredential" }>>,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  store: SessionStore,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  appliedEnvironment: Ref.Ref<Map<string, string>>,
  cells: HostedKernel.Interface,
  inspectCapabilities: Effect.Effect<WorkspaceCapabilitySnapshot, never, Crypto.Crypto | FileSystem.FileSystem>,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string>,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const crypto = yield* Crypto.Crypto
    const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
    function receive<A>(accept: (message: IncomingMessage) => A | undefined): Effect.Effect<A, HostError> {
      return Effect.gen(function* () {
        const message = yield* Queue.take(incoming)
        if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
        if (message._tag === "LeaseReceipt") {
          yield* runtime
            .receipt(message.receipt)
            .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
          yield* store.save(
            yield* runtime.persistedSession.pipe(
              Effect.mapError((cause) => HostError.make({ message: cause.message })),
            ),
          )
        }
        if (message._tag === "PhaseEnvironmentGranted") {
          if (
            message.operationKey !== null ||
            message.digest !== identity.environmentDigest ||
            (message.phase !== "setup" && message.phase !== "runtime")
          )
            return yield* HostError.make({
              message: "Workspace environment authorization does not match its bootstrap",
            })
          yield* applyPhaseGrant(
            message,
            grants,
            executionEnvironment,
            appliedEnvironment,
            cells,
            environmentAccess,
            redactedValues,
          )
        }
        const accepted = accept(message)
        return accepted === undefined ? yield* receive(accept) : accepted
      })
    }
    yield* receive((message) => (message._tag === "PhaseEnvironmentGranted" ? message : undefined))
    function runAttempt(
      attempt: number,
      retry: boolean,
    ): Effect.Effect<
      RepositoryCheckoutWire | null,
      HostError | WorkspaceError,
      ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | import("effect").Scope.Scope
    > {
      return Effect.gen(function* () {
        yield* writer(
          encodeExecutorMessage({
            _tag: "WorkspacePreparationRequested",
            access,
            workspaceId: config.workspaceId,
            wakeId: config.wakeId,
            cold: config.restoredSession !== undefined || identity.lifecycle === "resume",
            attempt,
            retry,
          }),
        ).pipe(Effect.mapError(() => HostError.make({ message: "Could not request workspace preparation" })))
        const assigned = yield* receive((message) =>
          message._tag === "WorkspacePreparationAssigned" &&
          sameAccess(access, message.access) &&
          message.workspaceId === config.workspaceId &&
          message.wakeId === config.wakeId &&
          message.attempt === attempt &&
          message.retry === retry
            ? message
            : undefined,
        )
        yield* Ref.set(bindingContractDigest, assigned.bindingContractDigest)
        const kernel = {
          profileDigest: kernelProfileDigest,
          bindingContractDigest: assigned.bindingContractDigest,
        } satisfies KernelIdentity
        const send = (message: Parameters<typeof encodeExecutorMessage>[0]) =>
          writer(encodeExecutorMessage(message)).pipe(
            Effect.mapError(() =>
              WorkspaceError.make({ phase: "capabilities", message: "Controller connection failed", retryable: true }),
            ),
          )
        const credential = Effect.fn("Host.repositoryCredential")(function* (purpose: "git-read" | "github-read") {
          const requestId = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() =>
              WorkspaceError.make({ phase: "checkout", message: "Credential request failed", retryable: true }),
            ),
          )
          const checkout = assigned.checkout
          if (checkout === null)
            return yield* WorkspaceError.make({
              phase: "checkout",
              message: "Assignment has no repository",
              retryable: false,
            })
          yield* send({
            _tag: "CredentialRequested",
            requestId,
            access,
            ownerId: checkout.ownerId,
            assignmentId: access.fence.assignmentId,
            repositoryId: checkout.repositoryId,
            workspaceId: assigned.workspaceId,
            purpose,
            assignmentGeneration: access.fence.assignmentGeneration,
            leaseEpoch: access.leaseEpoch,
          })
          const response = yield* Queue.take(credentials).pipe(
            Effect.filterOrFail(
              (message) =>
                message.credential.requestId === requestId &&
                message.credential.ownerId === checkout.ownerId &&
                message.credential.assignmentId === access.fence.assignmentId &&
                message.credential.repositoryId === checkout.repositoryId &&
                message.credential.workspaceId === assigned.workspaceId &&
                message.credential.purpose === purpose &&
                message.credential.assignmentGeneration === access.fence.assignmentGeneration &&
                message.credential.leaseEpoch === access.leaseEpoch,
              () => HostError.make({ message: "Repository credential response has a stale scope" }),
            ),
            Effect.map((message) => message.credential),
            Effect.mapError((error) =>
              WorkspaceError.make({ phase: "checkout", message: error.message, retryable: true }),
            ),
          )
          return {
            token: Redacted.make(response.token, { label: `repository-${purpose}` }),
            username: response.username,
            repositoryUrl: response.repositoryUrl,
            expiresAt: response.expiresAt,
          }
        })
        const revoke = (purpose: "git-read" | "github-read") => {
          const checkout = assigned.checkout
          if (checkout === null) return Effect.void
          return send({
            _tag: "CredentialRevocationRequested",
            access,
            ownerId: checkout.ownerId,
            assignmentId: access.fence.assignmentId,
            repositoryId: checkout.repositoryId,
            workspaceId: assigned.workspaceId,
            purpose,
            assignmentGeneration: access.fence.assignmentGeneration,
            leaseEpoch: access.leaseEpoch,
          })
        }
        const reporter = {
          started: (phase: import("../protocol/messages").WorkspacePreparationPhase) =>
            send({
              _tag: "WorkspacePreparationStarted",
              access,
              workspaceId: assigned.workspaceId,
              phase,
              attempt,
            }),
          output: (
            phase: import("../protocol/messages").WorkspacePreparationPhase,
            stream: "stdout" | "stderr",
            text: string,
            truncated: boolean,
          ) =>
            send({
              _tag: "WorkspacePreparationOutput",
              access,
              workspaceId: assigned.workspaceId,
              phase,
              attempt,
              stream,
              text,
              redacted: true,
              truncated,
            }),
        }
        const setupCache =
          identity.setupCache && assigned.checkout !== null
            ? {
                ownerId: identity.ownerId,
                load: (key: import("../workspace/archive").SetupCacheKey) =>
                  Effect.gen(function* () {
                    const requestId = yield* crypto.randomUUIDv4.pipe(
                      Effect.mapError(() => HostError.make({ message: "Setup cache lookup could not be identified" })),
                    )
                    yield* writer(encodeExecutorMessage({ _tag: "SetupCacheLookup", access, requestId, key })).pipe(
                      Effect.mapError(() => HostError.make({ message: "Setup cache lookup could not be sent" })),
                    )
                    const response = yield* receive((message) =>
                      message._tag === "SetupCacheResult" && message.requestId === requestId ? message : undefined,
                    )
                    return response.archive
                  }).pipe(Effect.catchCause(() => Effect.succeed(null))),
                store: (
                  key: import("../workspace/archive").SetupCacheKey,
                  archive: import("../protocol/messages").EncodedArchive,
                ) =>
                  Effect.gen(function* () {
                    const requestId = yield* crypto.randomUUIDv4.pipe(
                      Effect.mapError(() =>
                        HostError.make({ message: "Setup cache proposal could not be identified" }),
                      ),
                    )
                    yield* writer(
                      encodeExecutorMessage({ _tag: "SetupCacheProposed", access, requestId, key, archive }),
                    ).pipe(Effect.mapError(() => HostError.make({ message: "Setup cache proposal could not be sent" })))
                    yield* receive((message) =>
                      message._tag === "SetupCacheAccepted" && message.requestId === requestId ? message : undefined,
                    )
                  }).pipe(Effect.ignoreCause),
              }
            : undefined
        yield* reporter.started("checkout")
        const outcome = yield* Effect.result(
          prepareWorkspace({
            stateDirectory: config.stateDirectory,
            kernel,
            assignment: assigned,
            reporter,
            credential,
            revoke,
            environment: executionEnvironment,
            environmentDigest: identity.environmentDigest,
            ...(restore === null ? {} : { restore }),
            ...(setupCache === undefined ? {} : { setupCache }),
            secretValues: redactedValues,
          }),
        )
        if (outcome._tag === "Success") {
          yield* send({
            _tag: "WorkspacePreparationReady",
            access,
            workspaceId: assigned.workspaceId,
            phase: "capabilities",
            attempt,
            evidence: outcome.success,
          })
          const capabilities = yield* inspectCapabilities
          yield* send({
            _tag: "ExecutorWorkspaceReady",
            access,
            proof: {
              workspaceId: outcome.success.workspaceId,
              repositoryId: outcome.success.repositoryId,
              baseCommit: outcome.success.commitSha,
              headCommit: outcome.success.commitSha,
              setupHookDigest: outcome.success.lifecycle.setupHookDigest,
              environmentDigest: outcome.success.lifecycle.environmentDigest,
              templateBuildId: outcome.success.lifecycle.templateBuildId,
              restoredCheckpointId: outcome.success.lifecycle.restoredCheckpointId,
            },
            capabilities,
          })
          yield* receive((message) =>
            message._tag === "WorkspaceAccepted" && sameFence(message.fence, access.fence) ? message : undefined,
          )
          return assigned.checkout
        }
        const error = outcome.failure
        yield* send({
          _tag: "WorkspacePreparationFailed",
          access,
          workspaceId: assigned.workspaceId,
          phase: error.phase,
          attempt,
          message: error.message,
          retryable: error.retryable,
        })
        const next = yield* receive((message) =>
          message._tag === "WorkspacePreparationRetry" &&
          message.fence.assignmentId === access.fence.assignmentId &&
          message.fence.assignmentGeneration === access.fence.assignmentGeneration &&
          message.attempt > attempt
            ? message.attempt
            : undefined,
        )
        return yield* runAttempt(next, true)
      })
    }
    return yield* runAttempt(1, false).pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
  })

const sameAccess = (
  left: { readonly fence: Fence; readonly leaseEpoch: number; readonly sessionToken: string },
  right: typeof left,
) =>
  left.leaseEpoch === right.leaseEpoch && left.sessionToken === right.sessionToken && sameFence(left.fence, right.fence)

const attribution = (request: CellRequest) => ({
  operationKey: request.operationKey,
  workspaceId: request.workspaceId,
  sessionId: request.sessionId,
  threadId: request.threadId,
  turnId: request.turnId,
  runId: request.runId,
  rootRunId: request.rootRunId,
  toolCallId: request.toolCallId,
  attempt: request.attempt,
})

const sameAttribution = (left: ReturnType<typeof attribution>, right: ReturnType<typeof attribution>) =>
  left.operationKey === right.operationKey &&
  left.workspaceId === right.workspaceId &&
  left.sessionId === right.sessionId &&
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.runId === right.runId &&
  left.rootRunId === right.rootRunId &&
  left.toolCallId === right.toolCallId &&
  left.attempt === right.attempt

const executionKey = (operationKey: string, attempt: number) => `${operationKey}\u0000${attempt}`

const redactText = (value: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce((text, secret) => (secret.length === 0 ? text : text.split(secret).join("REDACTED")), value)

const redactJson = (value: unknown, secrets: ReadonlyArray<string>): unknown => {
  if (typeof value === "string") return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, secrets))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactText(key, secrets), redactJson(entry, secrets)]),
    )
  return value
}

const redactResponse = (response: CellResponse, secrets: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(CellResponseSchema)(redactJson(response, secrets))

const redactOutput = (value: unknown, secrets: ReadonlyArray<string>) => {
  const text = redactText(typeof value === "string" ? value : JSON.stringify(value), secrets)
    .replace(/(token|password|secret|authorization)["']?\s*[:=]\s*["'][^"']+/gi, "$1=REDACTED")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "REDACTED")
  return { text: text.slice(0, 16_384), truncated: text.length > 16_384 }
}

const workspaceFailure = (error: { readonly message: string }) => HostError.make({ message: error.message })

const ptyCreate = (connection: PtyConnection) => ({
  ptyId: connection.ptyId,
  command: connection.command,
  cwd: connection.cwd,
  cols: connection.cols,
  rows: connection.rows,
})

const dispatchPty = Effect.fn("Host.dispatchPty")(function* (
  message: IncomingMessage,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  delivery: Semaphore.Semaphore,
) {
  if (
    message._tag !== "PtyCreate" &&
    message._tag !== "PtyInput" &&
    message._tag !== "PtyResize" &&
    message._tag !== "PtyDisconnect" &&
    message._tag !== "PtyReconnect" &&
    message._tag !== "PtyTerminate"
  )
    return false
  const runtime = yield* Runtime
  const pty = yield* PtyManager
  const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
  if (!sameFence(access.fence, message.fence))
    return yield* HostError.make({ message: "PTY request has a stale executor fence" })
  const write = (outgoing: Parameters<typeof encodeExecutorMessage>[0]) =>
    writer(encodeExecutorMessage(outgoing)).pipe(
      Effect.mapError(() => HostError.make({ message: "Could not write PTY frame" })),
    )
  yield* delivery.withPermits(1)(
    Effect.gen(function* () {
      if (message._tag === "PtyCreate") {
        const opened = yield* pty.create(message.request)
        yield* write(
          opened.terminated
            ? { _tag: "PtyTerminated", access, ptyId: opened.ptyId, cursor: opened.cursor }
            : { _tag: "PtyOpened", access, pty: ptyCreate(opened) },
        )
        return
      }
      if (message._tag === "PtyInput") {
        yield* pty.input(message.request)
        return
      }
      if (message._tag === "PtyResize") {
        const resized = yield* pty.resize(message.request)
        yield* write({ _tag: "PtyOpened", access, pty: ptyCreate(resized) })
        return
      }
      if (message._tag === "PtyDisconnect") {
        const disconnected = yield* pty.disconnect(message.ptyId)
        yield* write({ _tag: "PtyDisconnected", access, ptyId: disconnected.ptyId, cursor: disconnected.cursor })
        return
      }
      if (message._tag === "PtyReconnect") {
        const reconnected = yield* pty.reconnect(message.request)
        yield* write({ _tag: "PtyOpened", access, pty: ptyCreate(reconnected) })
        if (reconnected.gap !== null)
          yield* write({ _tag: "PtyReplayGap", access, ptyId: reconnected.ptyId, gap: reconnected.gap })
        yield* Effect.forEach(
          reconnected.transcript,
          (chunk) => write({ _tag: "PtyOutput", access, ptyId: reconnected.ptyId, chunk }),
          { discard: true },
        )
        return
      }
      const terminated = yield* pty.terminate(message.ptyId)
      yield* write({ _tag: "PtyTerminated", access, ptyId: terminated.ptyId, cursor: terminated.cursor })
    }).pipe(Effect.mapError((cause) => HostError.make({ message: cause.message }))),
  )
  return true
})

const consumePtyEvents = (
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  delivery: Semaphore.Semaphore,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const pty = yield* PtyManager
    yield* pty.events.pipe(
      Stream.runForEach((event) =>
        delivery.withPermits(1)(
          Effect.gen(function* () {
            const access = yield* runtime.access
            const outgoing =
              event._tag === "Output"
                ? { _tag: "PtyOutput" as const, access, ptyId: event.ptyId, chunk: event.chunk }
                : { _tag: "PtyTerminated" as const, access, ptyId: event.ptyId, cursor: event.cursor }
            yield* writer(encodeExecutorMessage(outgoing))
          }),
        ),
      ),
      Effect.mapError((cause) => HostError.make({ message: cause.message })),
    )
  })

type PhaseGrant = Extract<IncomingMessage, { readonly _tag: "PhaseEnvironmentGranted" }>

const applyPhaseGrant = Effect.fn("Host.applyPhaseGrant")(function* (
  message: PhaseGrant,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  appliedEnvironment: Ref.Ref<Map<string, string>>,
  cells: HostedKernel.Interface,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string> = new Set(),
) {
  for (const name of message.redactedNames) {
    const value = message.values[name]
    if (value !== undefined) redactedValues.add(value)
  }
  if (message.operationKey !== null) {
    if (message.phase !== "runtime") return yield* HostError.make({ message: "Operation environment phase is invalid" })
    yield* Ref.update(grants, (current) => new Map(current).set(message.operationKey as string, message))
    return
  }
  yield* environmentAccess.withPermits(1)(
    Effect.gen(function* () {
      for (const name of Object.keys(executionEnvironment)) delete executionEnvironment[name]
      Object.assign(executionEnvironment, message.values)
      if (message.phase !== "runtime") return
      const applied = yield* Ref.get(appliedEnvironment)
      for (const [sessionId, digest] of applied) if (digest !== message.digest) yield* cells.restart(sessionId)
      yield* Ref.set(appliedEnvironment, new Map([...applied.keys()].map((sessionId) => [sessionId, message.digest])))
    }),
  )
})

const dispatchWorkspace = Effect.fn("Host.dispatchWorkspace")(function* (
  message: IncomingMessage,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
) {
  if (message._tag !== "WorkspaceRequest") return false
  const runtime = yield* Runtime
  const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
  if (!sameFence(access.fence, message.fence))
    return yield* HostError.make({ message: "Workspace request has a stale executor fence" })
  const files = yield* WorkspaceFiles
  const services = yield* RepositoryServices
  const request = message.request
  const response = yield* (() => {
    if (request._tag === "WorkspaceFileInspect") return files.inspect(request)
    if (request._tag === "RepositoryServiceEnsure")
      return services.ensure(request.service).pipe(
        Effect.match({
          onFailure: (error) => ({
            _tag: "RepositoryServiceRejected" as const,
            requestId: request.requestId,
            serviceId: request.service.serviceId,
            reason:
              error.kind === "conflict" || error.kind === "invalid" || error.kind === "missing"
                ? error.kind
                : ("unavailable" as const),
            message: error.message,
          }),
          onSuccess: () => ({
            _tag: "RepositoryServiceRunning" as const,
            requestId: request.requestId,
            serviceId: request.service.serviceId,
          }),
        }),
      )
    return services.stop(request.serviceId).pipe(
      Effect.match({
        onFailure: (error) => ({
          _tag: "RepositoryServiceRejected" as const,
          requestId: request.requestId,
          serviceId: request.serviceId,
          reason:
            error.kind === "conflict" || error.kind === "invalid" || error.kind === "missing"
              ? error.kind
              : ("unavailable" as const),
          message: error.message,
        }),
        onSuccess: () => ({
          _tag: "RepositoryServiceStopped" as const,
          requestId: request.requestId,
          serviceId: request.serviceId,
        }),
      }),
    )
  })()
  yield* writer(encodeExecutorMessage({ _tag: "WorkspaceResponse", access, response })).pipe(
    Effect.mapError(() => HostError.make({ message: "Could not write Workspace response" })),
  )
  return true
})

const cancelCell = Effect.fn("ExecutorHost.cancelCell")(function* (input: {
  readonly message: Extract<IncomingMessage, { readonly _tag: "CellCancel" }>
  readonly access: CellRequest["access"]
  readonly frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>
  readonly cells: HostedKernel.Interface
  readonly emit: (access: CellRequest["access"], frame: CellLifecycleFrame) => Effect.Effect<boolean, HostError>
}) {
  const key = executionKey(input.message.operationKey, input.message.attempt)
  const known = (yield* Ref.get(input.frames)).get(key)
  const accepted = known?.find((frame) => frame._tag === "Accepted")
  if (
    !sameAccess(input.access, input.message.access) ||
    known === undefined ||
    accepted === undefined ||
    accepted.attribution.attempt !== input.message.attempt
  )
    return yield* HostError.make({ message: "Cell cancellation has a stale executor fence" })
  const response = yield* input.cells
    .cancel(input.message.operationKey, input.message.attempt)
    .pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
  const interrupted = (yield* Ref.get(input.frames)).get(key)
  if (interrupted !== undefined && !interrupted.some((frame) => frame._tag === "Terminal")) {
    yield* input.emit(input.message.access, {
      _tag: "Terminal",
      attribution: accepted.attribution,
      cursor: interrupted.length + 1,
      outcome: terminalOutcome(response),
      response,
    })
  }
})

const admitCell = Effect.fn("ExecutorHost.admitCell")(function* (input: {
  readonly request: CellRequest
  readonly accepted: Extract<CellLifecycleFrame, { readonly _tag: "Accepted" }>
  readonly frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>
  readonly cells: HostedKernel.Interface
  readonly emit: (access: CellRequest["access"], frame: CellLifecycleFrame) => Effect.Effect<boolean, HostError>
}) {
  yield* input.cells.admit(input.request)
  const key = executionKey(input.request.operationKey, input.request.attempt)
  const admittedFrames = (yield* Ref.get(input.frames)).get(key) ?? []
  if (!admittedFrames.some((frame) => frame._tag === "Started"))
    yield* input.emit(input.request.access, {
      _tag: "Started",
      attribution: input.accepted.attribution,
      cursor: admittedFrames.length + 1,
    })
})

const consumeApi = (
  config: Config,
  incoming: Queue.Queue<IncomingMessage>,
  credentials: Queue.Queue<Extract<IncomingMessage, { readonly _tag: "RepositoryCredential" }>>,
  checkout: RepositoryCheckoutWire | null,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  store: SessionStore,
  receipts: OperationReceiptStore,
  operations: Ref.Ref<Map<string, Fiber.Fiber<void, unknown>>>,
  frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>,
  quiesced: Ref.Ref<boolean>,
  lifecycle: Semaphore.Semaphore,
  cells: HostedKernel.Interface,
  machine: Machine["Service"],
  ptyDelivery: Semaphore.Semaphore,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  appliedEnvironment: Ref.Ref<Map<string, string>>,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string>,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const crypto = yield* Crypto.Crypto
    const emit = (access: CellRequest["access"], frame: CellLifecycleFrame) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(frames)
          const key = executionKey(frame.attribution.operationKey, frame.attribution.attempt)
          const retained = current.get(key) ?? []
          if (retained.some((known) => known._tag === "Terminal") || frame.cursor !== retained.length + 1) return false
          const next = new Map(current)
          next.set(key, [...retained, frame])
          yield* Ref.set(frames, next)
          yield* receipts.save(next)
          yield* writer(encodeExecutorMessage({ _tag: "CellLifecycle", access, frame })).pipe(
            Effect.mapError(() => HostError.make({ message: "Could not write cell lifecycle frame" })),
          )
          return true
        }),
      )
    const loop = Effect.gen(function* () {
      const message = yield* Queue.take(incoming)
      if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
      if (message._tag === "LeaseReceipt") {
        yield* runtime
          .receipt(message.receipt)
          .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
        yield* persistSession(store)
      }
      if (message._tag === "BindingResult") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Binding result has a stale executor fence" })
        yield* cells
          .completeBinding(message)
          .pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
      }
      if (message._tag === "MachineExecute") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Machine request has a stale executor fence" })
        yield* machine
          .execute({
            machineId: message.machineId,
            requestDigest: message.requestDigest,
            request: message.request,
          })
          .pipe(
            Effect.flatMap((outcome) =>
              writer(
                encodeExecutorMessage({
                  _tag: "MachineResult",
                  access: message.access,
                  operationKey: message.operationKey,
                  attempt: message.attempt,
                  machineId: message.machineId,
                  requestDigest: message.requestDigest,
                  outcome,
                }),
              ),
            ),
            Effect.mapError((error) => HostError.make({ message: error.message })),
            Effect.forkScoped,
          )
      }
      if (yield* dispatchPty(message, writer, ptyDelivery)) return
      if (yield* dispatchWorkspace(message, writer)) return
      if (message._tag === "PhaseEnvironmentGranted") {
        yield* applyPhaseGrant(
          message,
          grants,
          executionEnvironment,
          appliedEnvironment,
          cells,
          environmentAccess,
          redactedValues,
        )
      }
      if (message._tag === "BranchPush") {
        const request = message.request
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        const valid =
          sameAccess(access, request.access) &&
          request.access.fence.assignmentId === config.fence.assignmentId &&
          request.access.fence.assignmentGeneration === config.fence.assignmentGeneration &&
          request.access.leaseEpoch === access.leaseEpoch &&
          request.workspaceId === config.workspaceId &&
          checkout !== null &&
          request.ownerId === checkout.ownerId &&
          request.repositoryId === checkout.repositoryId
        if (!valid) {
          yield* writer(
            encodeExecutorMessage({
              _tag: "BranchPushResult",
              access,
              publicationId: request.publicationId,
              branch: request.branch,
              commitSha: request.commitSha,
              outcome: { _tag: "Failed", kind: "stale", message: "Approved workspace assignment is not current" },
            }),
          )
        } else {
          yield* writer(
            encodeExecutorMessage({
              _tag: "CredentialRequested",
              requestId: request.publicationId,
              access,
              ownerId: request.ownerId,
              assignmentId: access.fence.assignmentId,
              repositoryId: request.repositoryId,
              workspaceId: request.workspaceId,
              purpose: "branch-push",
              publicationId: request.publicationId,
              branch: request.branch,
              ref: request.ref,
              commitSha: request.commitSha,
              assignmentGeneration: access.fence.assignmentGeneration,
              leaseEpoch: access.leaseEpoch,
            }),
          )
          const supplied = yield* Queue.take(credentials)
          const wire = supplied.credential
          const credentialValid =
            wire.requestId === request.publicationId &&
            wire.ownerId === request.ownerId &&
            wire.assignmentId === access.fence.assignmentId &&
            wire.repositoryId === request.repositoryId &&
            wire.workspaceId === request.workspaceId &&
            wire.purpose === "branch-push" &&
            wire.publicationId === request.publicationId &&
            wire.branch === request.branch &&
            wire.ref === request.ref &&
            wire.commitSha === request.commitSha &&
            wire.assignmentGeneration === access.fence.assignmentGeneration &&
            wire.leaseEpoch === access.leaseEpoch
          const outcome = credentialValid
            ? yield* pushApprovedBranch({
                request,
                repositoryUrl: `https://github.com/${checkout.owner}/${checkout.name}.git`,
                credential: {
                  token: Redacted.make(wire.token, { label: "repository-branch-push" }),
                  username: wire.username,
                  repositoryUrl: wire.repositoryUrl,
                  expiresAt: wire.expiresAt,
                },
                root: yield* workspaceRoot,
              })
            : { _tag: "Failed" as const, kind: "stale" as const, message: "Branch credential scope is stale" }
          yield* writer(
            encodeExecutorMessage({
              _tag: "CredentialRevocationRequested",
              access,
              ownerId: request.ownerId,
              assignmentId: access.fence.assignmentId,
              repositoryId: request.repositoryId,
              workspaceId: request.workspaceId,
              purpose: "branch-push",
              publicationId: request.publicationId,
              branch: request.branch,
              ref: request.ref,
              commitSha: request.commitSha,
              assignmentGeneration: access.fence.assignmentGeneration,
              leaseEpoch: access.leaseEpoch,
            }),
          )
          yield* writer(
            encodeExecutorMessage({
              _tag: "BranchPushResult",
              access,
              publicationId: request.publicationId,
              branch: request.branch,
              commitSha: request.commitSha,
              outcome,
            }),
          )
        }
      }
      if (message._tag === "CellExecute") {
        if (yield* Ref.get(quiesced))
          return yield* HostError.make({ message: "Cell admission is closed while the executor is quiesced" })
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.request.access))
          return yield* HostError.make({ message: "Cell request has a stale executor fence" })
        const phase = (yield* Ref.get(grants)).get(message.request.operationKey)
        if (phase === undefined) return yield* HostError.make({ message: "Cell request has no runtime authorization" })
        yield* Ref.update(grants, (current) => {
          const next = new Map(current)
          next.delete(message.request.operationKey)
          return next
        })
        const identity = attribution(message.request)
        const key = executionKey(message.request.operationKey, message.request.attempt)
        const retained = (yield* Ref.get(frames)).get(key)
        if (retained !== undefined) {
          const retainedAccepted = retained.find((frame) => frame._tag === "Accepted")
          if (retainedAccepted === undefined || !sameAttribution(retainedAccepted.attribution, identity))
            return yield* HostError.make({ message: "Cell operation identity conflicts with retained execution" })
          if (retained.some((frame) => frame._tag === "Terminal") || (yield* Ref.get(operations)).has(key)) {
            yield* Effect.forEach(
              retained,
              (frame) => writer(encodeExecutorMessage({ _tag: "CellLifecycle", access, frame })),
              { discard: true },
            )
            return
          }
        }
        const accepted =
          retained?.find(
            (frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Accepted" }> => frame._tag === "Accepted",
          ) ?? ({ _tag: "Accepted", attribution: identity, cursor: 1 } as const)
        if (retained === undefined) yield* emit(message.request.access, accepted)
        const admission = yield* admitCell({ request: message.request, accepted, frames, cells, emit }).pipe(
          Effect.match({
            onFailure: (error) =>
              ({
                _tag: "Failure" as const,
                response: {
                  _tag: "DomainFailure" as const,
                  failure: { kind: error._tag === "CellError" ? error.kind : "execution", message: error.message },
                },
              }) satisfies { readonly _tag: "Failure"; readonly response: CellResponse },
            onSuccess: () => ({ _tag: "Success" as const }),
          }),
        )
        if (admission._tag === "Failure") {
          const admittedFrames = (yield* Ref.get(frames)).get(key) ?? []
          yield* emit(message.request.access, {
            _tag: "Terminal",
            attribution: accepted.attribution,
            cursor: admittedFrames.length + 1,
            outcome: terminalOutcome(admission.response),
            response: admission.response,
          })
          return
        }
        const operation = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const secrets = phase.redactedNames.flatMap((name) => {
              const value = phase.values[name]
              return value === undefined ? [] : [value]
            })
            const response = yield* restore(
              HostedObservability.observe(
                "cell_execution",
                cellCorrelation(message.request),
                environmentAccess
                  .withPermits(1)(
                    Effect.gen(function* () {
                      const applied = yield* Ref.get(appliedEnvironment)
                      const previousDigest = applied.get(message.request.sessionId)
                      if (previousDigest !== phase.digest) {
                        for (const name of Object.keys(executionEnvironment)) delete executionEnvironment[name]
                        Object.assign(executionEnvironment, phase.values)
                        if (previousDigest !== undefined) yield* cells.restart(message.request.sessionId)
                        yield* Ref.set(
                          appliedEnvironment,
                          new Map(applied).set(message.request.sessionId, phase.digest),
                        )
                      }
                      const result = yield* cells.execute(message.request, (chunk) =>
                        Effect.gen(function* () {
                          const output = redactOutput(chunk.text, secrets)
                          const outputFrames = (yield* Ref.get(frames)).get(key) ?? []
                          if (outputFrames.filter((frame) => frame._tag === "Output").length >= 16) return
                          yield* emit(message.request.access, {
                            _tag: "Output",
                            attribution: accepted.attribution,
                            cursor: outputFrames.length + 1,
                            stream: chunk.stream,
                            text: output.text,
                            redacted: true,
                            truncated: output.truncated,
                          }).pipe(Effect.ignore)
                        }),
                      )
                      return redactResponse(result, secrets)
                    }),
                  )
                  .pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.failCause(cause)
                        : Effect.succeed({
                            _tag: "DomainFailure" as const,
                            failure: { kind: "execution", message: "Cell execution failed" },
                          }),
                    ),
                  ),
                (result) => (result._tag === "DomainFailure" ? "failure" : "success"),
              ),
            )
            const completedFrames = (yield* Ref.get(frames)).get(key) ?? []
            yield* emit(message.request.access, {
              _tag: "Terminal",
              attribution: accepted.attribution,
              cursor: completedFrames.length + 1,
              outcome: terminalOutcome(response),
              response,
            })
          }),
        ).pipe(
          Effect.ensuring(
            Ref.update(operations, (values) => {
              const next = new Map(values)
              next.delete(key)
              return next
            }),
          ),
        )
        const gate = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkScoped(Deferred.await(gate).pipe(Effect.andThen(operation)))
        yield* Ref.update(operations, (values) => new Map(values).set(key, fiber))
        yield* Deferred.succeed(gate, undefined)
      }
      if (message._tag === "CellCancel") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        yield* cancelCell({ message, access, frames, cells, emit })
      }
      if (message._tag === "CellReplay") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        const known = (yield* Ref.get(frames)).get(executionKey(message.operationKey, message.attempt)) ?? []
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Cell replay has a stale executor fence" })
        yield* Effect.forEach(
          known.filter((frame) => frame.cursor > message.afterCursor),
          (frame) => writer(encodeExecutorMessage({ _tag: "CellLifecycle", access: message.access, frame })),
          { discard: true },
        )
      }
      if (message._tag === "CellTerminalReceipt") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        const known = (yield* Ref.get(frames)).get(executionKey(message.operationKey, message.attempt)) ?? []
        const terminal = known.find(
          (frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> =>
            frame._tag === "Terminal" &&
            frame.attribution.attempt === message.attempt &&
            frame.cursor === message.cursor,
        )
        if (terminal !== undefined && sameAccess(access, message.access))
          yield* writer(
            encodeExecutorMessage({
              _tag: "CellResult",
              access: message.access,
              operationKey: message.operationKey,
              attempt: message.attempt,
              response: terminal.response,
            }),
          )
      }
      if (message._tag === "CellTerminalSuperseded") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Cell terminal supersession has a stale executor fence" })
      }
      if (message._tag === "Quiesce") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (
          access.fence.assignmentId !== message.fence.assignmentId ||
          access.fence.assignmentGeneration !== message.fence.assignmentGeneration ||
          access.fence.instanceId !== message.fence.instanceId ||
          access.fence.executorId !== message.fence.executorId
        )
          return yield* HostError.make({ message: "Quiesce request has a stale executor fence" })
        yield* Ref.set(quiesced, true)
        const active = yield* Ref.get(operations)
        yield* Effect.forEach(active.values(), Fiber.interrupt, { discard: true })
        const retained = yield* Ref.get(frames)
        for (const operationFrames of retained.values()) {
          if (operationFrames.some((frame) => frame._tag === "Terminal")) continue
          const accepted = operationFrames.find((frame) => frame._tag === "Accepted")
          if (accepted === undefined) continue
          yield* emit(access, {
            _tag: "Terminal",
            attribution: accepted.attribution,
            cursor: operationFrames.length + 1,
            outcome: "unknown",
            response: {
              _tag: "DomainFailure",
              failure: { kind: "unknown", message: "Cell operation outcome is unknown after quiesce" },
            },
          })
        }
        const completed = yield* Ref.get(frames)
        const statuses = [...completed.values()].flatMap((operationFrames) => {
          const terminal = operationFrames.find(
            (frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> => frame._tag === "Terminal",
          )
          return terminal === undefined
            ? []
            : [{ operationKey: terminal.attribution.operationKey, outcome: terminal.outcome }]
        })
        const operationStatuses = [...new Map(statuses.map((status) => [status.operationKey, status])).values()]
        const checkpointId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(workspaceFailure))
        const archive = encodeArchive(
          yield* createArchive(yield* workspaceRoot, redactedValues).pipe(Effect.mapError(workspaceFailure)),
        )
        const cursor = yield* runtime.cursor.pipe(Effect.mapError(workspaceFailure))
        yield* writer(
          encodeExecutorMessage({
            _tag: "ExecutorQuiesced",
            access,
            requestId: message.requestId,
            operations: operationStatuses,
            checkpoint: {
              version: 1,
              checkpointId,
              archive,
              cursor,
            },
          }),
        ).pipe(Effect.mapError(workspaceFailure))
      }
    })
    return yield* loop.pipe(Effect.forever)
  })

const connect = Effect.fn("Host.connect")(function* (
  config: Config,
  kernelProfileDigest: string,
  bindingContractDigest: Ref.Ref<string | undefined>,
  identity: Identity,
  restore: CheckpointRestore | null,
  store: SessionStore,
  receipts: OperationReceiptStore,
  operations: Ref.Ref<Map<string, Fiber.Fiber<void, unknown>>>,
  frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>,
  quiesced: Ref.Ref<boolean>,
  lifecycle: Semaphore.Semaphore,
  cells: HostedKernel.Interface,
  inspectCapabilities: Effect.Effect<WorkspaceCapabilitySnapshot, never, Crypto.Crypto | FileSystem.FileSystem>,
  makeMachine: Effect.Effect<Machine["Service"], never, import("effect").Scope.Scope>,
  ptyDelivery: Semaphore.Semaphore,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  appliedEnvironment: Ref.Ref<Map<string, string>>,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string>,
  connected: Effect.Effect<void> = Effect.void,
) {
  const runtime = yield* Runtime
  const socket = yield* Socket.makeWebSocket(config.apiUrl)
  const writer = yield* socket.writer
  yield* Ref.set(activeWriter, writer)
  const incoming = yield* Queue.make<IncomingMessage>()
  const credentials = yield* Queue.make<Extract<IncomingMessage, { readonly _tag: "RepositoryCredential" }>>()
  const reader = yield* socket
    .runString((frame) =>
      decodeApiMessage(frame).pipe(
        Effect.mapError(() => HostError.make({ message: "Controller sent an invalid executor frame" })),
        Effect.flatMap((message) =>
          message._tag === "RepositoryCredential" ? Queue.offer(credentials, message) : Queue.offer(incoming, message),
        ),
      ),
    )
    .pipe(Effect.forkScoped)
  const opening = !(yield* runtime.hasSession)
    ? {
        _tag: "ExecutorHello" as const,
        hello: yield* runtime.hello,
        lifecycle: identity.lifecycle,
        environmentDigest: identity.environmentDigest,
      }
    : { _tag: "ExecutorReconnect" as const, access: yield* runtime.reconnect }
  yield* writer(encodeExecutorMessage(opening))
  yield* waitForWelcome(incoming, store)
  const session = yield* runtime.persistedSession
  const heartbeat = Effect.sleep(session.heartbeatIntervalMillis).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const cursor = yield* runtime.cursor
        const frame = yield* runtime.heartbeat(cursor)
        yield* writer(encodeExecutorMessage({ _tag: "ExecutorHeartbeat", heartbeat: frame }))
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  )
  yield* heartbeat
  const checkout = yield* HostedObservability.observe(
    "attach",
    {
      assignmentId: config.fence.assignmentId,
      sandboxId: config.fence.instanceId,
      ...(config.templateBuildId === null ? {} : { buildId: config.templateBuildId }),
    },
    prepare(
      config,
      kernelProfileDigest,
      bindingContractDigest,
      identity,
      restore,
      incoming,
      credentials,
      writer,
      store,
      grants,
      executionEnvironment,
      appliedEnvironment,
      cells,
      inspectCapabilities,
      environmentAccess,
      redactedValues,
    ),
  )
  yield* RepositoryServices.pipe(
    Effect.flatMap((services) => services.resume),
    Effect.mapError((error) => HostError.make({ message: error.message })),
  )
  const machine = yield* makeMachine
  yield* runtime.access.pipe(
    Effect.flatMap(cells.replayBindings),
    Effect.mapError((error) => HostError.make({ message: error.message })),
  )
  yield* connected
  const connectedSession = Effect.raceFirst(
    Effect.raceFirst(
      Fiber.join(reader).pipe(
        Effect.mapError(() => HostError.make({ message: "Executor controller connection closed" })),
      ),
      consumeApi(
        config,
        incoming,
        credentials,
        checkout,
        writer,
        store,
        receipts,
        operations,
        frames,
        quiesced,
        lifecycle,
        cells,
        machine,
        ptyDelivery,
        grants,
        executionEnvironment,
        appliedEnvironment,
        environmentAccess,
        redactedValues,
      ),
    ),
    consumePtyEvents(writer, ptyDelivery),
  )
  const pty = yield* PtyManager
  return yield* connectedSession.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* pty.disconnectAll.pipe(Effect.ignore)
        const running = yield* Ref.getAndSet(operations, new Map())
        yield* Effect.forEach(running.values(), Fiber.interrupt, { discard: true })
        yield* Ref.set(activeWriter, undefined)
      }),
    ),
  )
})

const receiveBootstrap = Effect.suspend(() => {
  let consumed = false
  const callbackRuntime = ManagedRuntime.make(BunServices.layer)
  let server: ReturnType<typeof Bun.serve>
  const receive = Effect.callback<Bootstrap, HostError>((resume) => {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 7070,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (path === "/health") return new Response("ready")
        if (path !== "/.rika/bootstrap" || request.method !== "POST" || consumed)
          return new Response("not found", { status: 404 })
        const handleBootstrapRequest = Effect.tryPromise({
          try: () => request.json(),
          catch: () => HostError.make({ message: "Bootstrap request body is invalid" }),
        }).pipe(
          Effect.flatMap((input) =>
            Effect.all([
              decodeBootstrap(input).pipe(Effect.option),
              sandboxInstanceId,
              EffectConfig.string("RIKA_EXECUTOR_STATE_DIRECTORY").pipe(
                EffectConfig.withDefault(executorStateDirectory),
              ),
            ]),
          ),
          Effect.map(([bodyOption, instanceId, stateDirectory]) => {
            const body = bodyOption._tag === "Some" ? bodyOption.value : undefined
            if (body === undefined || instanceId.length === 0 || body.identity.instanceId !== instanceId)
              return new Response("invalid", { status: 400 })
            if (consumed) return new Response("not found", { status: 404 })
            consumed = true
            const bootstrap = {
              credential: Redacted.make(body.credential, { label: "executor-bootstrap" }),
              identity: { ...body.identity, stateDirectory },
              restore: body.restore,
            }
            return new Response(
              new ReadableStream({
                pull: (controller) => {
                  controller.enqueue(new TextEncoder().encode("accepted"))
                  controller.close()
                  setImmediate(() => resume(Effect.succeed(bootstrap)))
                },
              }),
              { status: 202 },
            )
          }),
          Effect.orElseSucceed(() => new Response("invalid", { status: 400 })),
        )
        return callbackRuntime.runPromise(handleBootstrapRequest)
      },
    })
  })
  return receive.pipe(
    Effect.ensuring(
      Effect.suspend(() => stopServerAdapter(server)).pipe(Effect.ensuring(callbackRuntime.disposeEffect)),
    ),
  )
})

export const testing = {
  admitCell,
  applyPhaseGrant,
  cancelCell,
  dispatchPty,
  dispatchWorkspace,
  operationReceiptStore,
  receiveBootstrap,
  redactOutput,
  redactResponse,
  sameFence,
} as const

const host = Effect.scoped(
  Effect.gen(function* () {
    const environmentIdentity = yield* executorIdentity
    const root = yield* workspaceRoot
    const cellStateDirectory = `${environmentIdentity.stateDirectory}/cells`
    const machineStateDirectory = `${environmentIdentity.stateDirectory}/machines`
    const store = yield* sessionStore(environmentIdentity.stateDirectory)
    const persisted = yield* store.load
    const matchingSession =
      Option.isSome(persisted) && restores(environmentIdentity, persisted.value) ? persisted.value : undefined
    if (Option.isSome(persisted) && matchingSession === undefined)
      yield* HostedObservability.health("restore_failure", {
        assignmentId: environmentIdentity.assignmentId,
        sandboxId: environmentIdentity.instanceId,
        ...(environmentIdentity.templateBuildId === null ? {} : { buildId: environmentIdentity.templateBuildId }),
      })
    const crypto = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const statePath = Effect.fn("Host.cellStatePath")(function* (operationKey: string) {
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(operationKey))
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not identify cell state" })))
      return `${cellStateDirectory}/${Encoding.encodeHex(digest)}.json`
    })
    const readState = Effect.fn("Host.readCellState")(function* (operationKey: string) {
      const filename = yield* statePath(operationKey)
      const exists = yield* fileSystem
        .exists(filename)
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not inspect cell state" })))
      if (!exists) return undefined
      const text = yield* fileSystem
        .readFileString(filename)
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not read cell state" })))
      return yield* decodeCellState(text).pipe(
        Effect.mapError(() => CellError.make({ kind: "execution", message: "Cell state is invalid" })),
      )
    })
    const writeState = Effect.fn("Host.writeCellState")(function* (operationKey: string, state: CellStateValue) {
      const filename = yield* statePath(operationKey)
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeCellState(state).pipe(
        Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not encode cell state" })),
      )
      yield* fileSystem
        .makeDirectory(cellStateDirectory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not create cell state" })))
      yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 }).pipe(
        Effect.flatMap(() => fileSystem.rename(temporary, filename)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not persist cell state" })),
      )
    })
    const machinePath = Effect.fn("Host.machineStatePath")(function* (machineId: string) {
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(machineId))
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not identify machine state" })))
      return `${machineStateDirectory}/${Encoding.encodeHex(digest)}.json`
    })
    const readMachine = Effect.fn("Host.readMachineState")(function* (machineId: string) {
      const filename = yield* machinePath(machineId)
      const exists = yield* fileSystem
        .exists(filename)
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not inspect machine state" })))
      if (!exists) return undefined
      const text = yield* fileSystem
        .readFileString(filename)
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not read machine state" })))
      return yield* decodeMachineState(text).pipe(
        Effect.mapError(() => MachineError.make({ message: "Machine state is invalid" })),
      )
    })
    const writeMachine = Effect.fn("Host.writeMachineState")(function* (machineId: string, state: MachineStateValue) {
      const filename = yield* machinePath(machineId)
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeMachineState(state).pipe(
        Effect.mapError(() => MachineError.make({ message: "Could not encode machine state" })),
      )
      yield* fileSystem
        .makeDirectory(machineStateDirectory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not create machine state" })))
      yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 }).pipe(
        Effect.flatMap(() => fileSystem.rename(temporary, filename)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => MachineError.make({ message: "Could not persist machine state" })),
      )
    })
    const run = (
      identity: Identity,
      bootstrapToken: Redacted.Redacted<string>,
      restoredSession: SessionWire | undefined,
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
        const runtime = runtimeLayer({
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
          ...(config.restoredSession === undefined ? {} : { restoredSession: config.restoredSession }),
        })
        const executionEnvironment: Record<string, string> = {}
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
        const makeMachine = Layer.build(machineLayer({ workspace: root, read: readMachine, write: writeMachine })).pipe(
          Effect.map((context) => Context.get(context, Machine)),
        )
        const operations = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
        const frames = yield* Ref.make(yield* receipts.load)
        const quiesced = yield* Ref.make(false)
        const lifecycle = yield* Semaphore.make(1)
        const ptyDelivery = yield* Semaphore.make(1)
        const grants = yield* Ref.make(new Map<string, PhaseGrant>())
        const appliedEnvironment = yield* Ref.make(new Map<string, string>())
        const environmentAccess = yield* Semaphore.make(1)
        const redactedValues = new Set<string>()
        return yield* Effect.scoped(
          connect(
            config,
            kernelProfileDigest,
            bindingContractDigest,
            identity,
            restore,
            store,
            receipts,
            operations,
            frames,
            quiesced,
            lifecycle,
            cells,
            inspectCapabilities,
            makeMachine,
            ptyDelivery,
            activeWriter,
            grants,
            executionEnvironment,
            appliedEnvironment,
            environmentAccess,
            redactedValues,
            connected,
          ),
        ).pipe(
          Effect.provide(Context.merge(Context.merge(runtimeContext, ptyContext), workspaceContext)),
          Effect.catchCause(() => Effect.sleep("1 second")),
          Effect.forever,
        )
      }).pipe(
        Effect.tapError(() =>
          HostedObservability.health(restoredSession === undefined ? "setup_failure" : "restore_failure", {
            assignmentId: identity.assignmentId,
            sandboxId: identity.instanceId,
            ...(identity.templateBuildId === null ? {} : { buildId: identity.templateBuildId }),
          }),
        ),
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
        const running = yield* Effect.forkScoped(run(identity, bootstrapToken, restoredSession, restore))
        return yield* monitor(running)
      })
    if (matchingSession === undefined) {
      const bootstrap = yield* Effect.scoped(receiveBootstrap)
      return yield* supervise(bootstrap.identity, bootstrap.credential, undefined, bootstrap.restore)
    }
    const selected = yield* Deferred.make<"bootstrap" | "reconnect">()
    const fresh = yield* Effect.forkScoped(
      Effect.scoped(receiveBootstrap).pipe(
        Effect.flatMap((bootstrap) =>
          run(
            bootstrap.identity,
            bootstrap.credential,
            undefined,
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
