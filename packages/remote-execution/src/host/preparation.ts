import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { Crypto, Effect, FileSystem, Queue, Redacted, Ref, Semaphore, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type * as Socket from "effect/unstable/socket/Socket"
import { Runtime } from "./runtime"
import { HostError } from "./error"
import type { Config, Identity } from "./identity"
import type { SessionStore } from "./persistence"
import {
  ExecutorMessage,
  type ApiMessage as IncomingMessage,
  type CheckpointRestore,
  type Fence,
  type RepositoryCheckoutWire,
  type WorkspaceSeedRestore,
} from "../protocol/messages"
import { prepare as prepareWorkspace, WorkspaceError, type NativeToolRuntimeIdentity } from "../workspace/service"

const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))

type PhaseGrant = Extract<IncomingMessage, { readonly _tag: "PhaseEnvironmentGranted" }>

type ApplyPhaseGrant = (
  message: PhaseGrant,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string>,
) => Effect.Effect<void, HostError>

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
  nativeToolRuntimeDigest: string,
  identity: Identity,
  seed: WorkspaceSeedRestore | null,
  restore: CheckpointRestore | null,
  incoming: Queue.Queue<IncomingMessage>,
  credentials: Queue.Queue<Extract<IncomingMessage, { readonly _tag: "RepositoryCredential" }>>,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  store: SessionStore,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  inspectCapabilities: Effect.Effect<WorkspaceCapabilitySnapshot, never, Crypto.Crypto | FileSystem.FileSystem>,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string>,
  applyPhaseGrant: ApplyPhaseGrant,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const crypto = yield* Crypto.Crypto
    const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
    function receive<A>(accept: (message: IncomingMessage) => A | undefined): Effect.Effect<A, HostError> {
      return Effect.gen(function* () {
        const message = yield* Queue.take(incoming)
        if (message._tag === "Fenced") return yield* HostError.make({ message: message.message, permanent: true })
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
              message: `Workspace environment authorization does not match its bootstrap (granted ${message.phase} ${message.digest}, bootstrapped ${identity.environmentDigest})`,
              permanent: true,
            })
          yield* applyPhaseGrant(message, grants, executionEnvironment, environmentAccess, redactedValues)
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
        const nativeToolRuntime = {
          digest: nativeToolRuntimeDigest,
        } satisfies NativeToolRuntimeIdentity
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
                load: (key: import("../workspace/artifact/archive").SetupCacheKey) =>
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
                  key: import("../workspace/artifact/archive").SetupCacheKey,
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
        const workspaceOptions = {
          stateDirectory: config.stateDirectory,
          nativeToolRuntime,
          assignment: assigned,
          reporter,
          credential,
          revoke,
          environment: executionEnvironment,
          environmentDigest: identity.environmentDigest,
          secretValues: redactedValues,
        }
        const seededOptions = seed === null ? workspaceOptions : { ...workspaceOptions, seed }
        const restoredOptions = restore === null ? seededOptions : { ...seededOptions, restore }
        const preparedOptions = setupCache === undefined ? restoredOptions : { ...restoredOptions, setupCache }
        const outcome = yield* Effect.result(prepareWorkspace(preparedOptions))
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

export const preparation = { persistSession, prepare, sameAccess, sameFence, waitForWelcome }
