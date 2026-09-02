import { Crypto, Effect, Queue, Redacted, Ref, Semaphore } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as Operations from "../protocol/operations"
import type {
  AccessWire,
  ApiMessage as IncomingMessage,
  BranchPushOutcome,
  BranchPushRequest,
  ExecutorMessage,
  Fence,
  RepositoryCheckoutWire,
} from "../protocol/messages"
import { encodeArchive } from "../workspace/artifact/archive"
import { createArchive } from "../workspace/artifact/archive-upload"
import { pushApprovedBranch } from "../workspace/service"
import { HostError } from "./error"
import type { Config } from "./identity"
import type { SessionStore } from "./persistence"
import { Runtime } from "./runtime"
import { Manager as PtyManager } from "./terminal/pty"
import { WorkspaceFiles } from "../workspace/files"
import { RepositoryServices } from "../workspace/repositories"
import type { PhaseGrant } from "./dispatch-pty-workspace"

type Writer = (chunk: string) => Effect.Effect<void, Socket.SocketError>
type Encoder = (message: ExecutorMessage) => string
type RepositoryCredential = Extract<IncomingMessage, { readonly _tag: "RepositoryCredential" }>
type Access = { readonly fence: Fence; readonly leaseEpoch: number; readonly sessionToken: string }
type Dispatch = (
  message: IncomingMessage,
  writer: Writer,
) => Effect.Effect<boolean, HostError, Runtime | WorkspaceFiles | RepositoryServices>

interface ApiDispatchDependencies {
  readonly config: Config
  readonly incoming: Queue.Queue<IncomingMessage>
  readonly credentials: Queue.Queue<RepositoryCredential>
  readonly checkout: RepositoryCheckoutWire | null
  readonly writer: Writer
  readonly store: SessionStore
  readonly quiesced: Ref.Ref<boolean>
  readonly operationLifecycle: Operations.Interface
  readonly ptyDelivery: Semaphore.Semaphore
  readonly grants: Ref.Ref<Map<string, PhaseGrant>>
  readonly executionEnvironment: Record<string, string>
  readonly environmentAccess: Semaphore.Semaphore
  readonly redactedValues: Set<string>
}

interface ApiDispatchFunctions {
  readonly encode: Encoder
  readonly persistSession: (store: SessionStore) => Effect.Effect<void, HostError, Runtime>
  readonly sameAccess: (left: Access, right: Access) => boolean
  readonly dispatchPty: (
    message: IncomingMessage,
    writer: Writer,
    delivery: Semaphore.Semaphore,
  ) => Effect.Effect<boolean, HostError, Runtime | PtyManager>
  readonly dispatchWorkspace: Dispatch
  readonly applyPhaseGrant: (
    message: PhaseGrant,
    grants: Ref.Ref<Map<string, PhaseGrant>>,
    environment: Record<string, string>,
    access: Semaphore.Semaphore,
    redacted: Set<string>,
  ) => Effect.Effect<void, HostError>
  readonly workspaceRoot: Effect.Effect<string, HostError>
}

const hostFailure = (error: { readonly message: string }) => HostError.make({ message: error.message })
const operationMessage = (message: IncomingMessage): message is Parameters<Operations.Interface["dispatch"]>[0] =>
  message._tag === "MachineExecute" || message._tag === "MachineCancel"

const consumeReceipt = Effect.fn("Host.consumeReceipt")(function* (
  message: IncomingMessage,
  dependencies: ApiDispatchDependencies,
  functions: ApiDispatchFunctions,
) {
  if (message._tag !== "LeaseReceipt") return
  const runtime = yield* Runtime
  yield* runtime.receipt(message.receipt).pipe(Effect.mapError(hostFailure))
  yield* functions.persistSession(dependencies.store)
})

const assignmentCurrent = (dependencies: ApiDispatchDependencies, access: AccessWire, request: BranchPushRequest) => {
  const checkout = dependencies.checkout
  return (
    dependencies.config.fence.assignmentId === request.access.fence.assignmentId &&
    dependencies.config.fence.assignmentGeneration === request.access.fence.assignmentGeneration &&
    request.access.leaseEpoch === access.leaseEpoch &&
    request.workspaceId === dependencies.config.workspaceId &&
    checkout !== null &&
    request.ownerId === checkout.ownerId &&
    request.repositoryId === checkout.repositoryId
  )
}

const credentialCurrent = (wire: RepositoryCredential["credential"], request: BranchPushRequest, access: AccessWire) =>
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

const publicationFrame = (
  tag: "CredentialRequested" | "CredentialRevocationRequested",
  request: BranchPushRequest,
  access: AccessWire,
): ExecutorMessage => ({
  _tag: tag,
  requestId: request.publicationId,
  access,
  ownerId: request.ownerId,
  assignmentId: access.fence.assignmentId,
  repositoryId: request.repositoryId,
  workspaceId: request.workspaceId,
  purpose: "branch-push" as const,
  publicationId: request.publicationId,
  branch: request.branch,
  ref: request.ref,
  commitSha: request.commitSha,
  assignmentGeneration: access.fence.assignmentGeneration,
  leaseEpoch: access.leaseEpoch,
})

const consumeBranchPush = Effect.fn("Host.consumeBranchPush")(function* (
  message: IncomingMessage,
  dependencies: ApiDispatchDependencies,
  functions: ApiDispatchFunctions,
) {
  if (message._tag !== "BranchPush") return
  const runtime = yield* Runtime
  const request = message.request
  const access = yield* runtime.access.pipe(Effect.mapError(hostFailure))
  const result = (outcome: BranchPushOutcome) =>
    dependencies.writer(
      functions.encode({
        _tag: "BranchPushResult",
        access,
        publicationId: request.publicationId,
        branch: request.branch,
        commitSha: request.commitSha,
        outcome,
      }),
    )
  if (!functions.sameAccess(access, request.access) || !assignmentCurrent(dependencies, access, request))
    return yield* result({ _tag: "Failed", kind: "stale", message: "Approved workspace assignment is not current" })
  yield* dependencies.writer(functions.encode(publicationFrame("CredentialRequested", request, access)))
  const wire = (yield* Queue.take(dependencies.credentials)).credential
  const checkout = dependencies.checkout!
  const outcome = credentialCurrent(wire, request, access)
    ? yield* pushApprovedBranch({
        request,
        repositoryUrl: `https://github.com/${checkout.owner}/${checkout.name}.git`,
        credential: {
          token: Redacted.make(wire.token, { label: "repository-branch-push" }),
          username: wire.username,
          repositoryUrl: wire.repositoryUrl,
          expiresAt: wire.expiresAt,
        },
        root: yield* functions.workspaceRoot,
      })
    : { _tag: "Failed" as const, kind: "stale" as const, message: "Branch credential scope is stale" }
  yield* dependencies.writer(functions.encode(publicationFrame("CredentialRevocationRequested", request, access)))
  yield* result(outcome)
})

const consumeOperation = (message: IncomingMessage, dependencies: ApiDispatchDependencies) =>
  operationMessage(message)
    ? dependencies.operationLifecycle.dispatch(message).pipe(Effect.mapError(hostFailure))
    : Effect.void

const consumeQuiesce = Effect.fn("Host.consumeQuiesce")(function* (
  message: IncomingMessage,
  dependencies: ApiDispatchDependencies,
  functions: ApiDispatchFunctions,
) {
  if (message._tag !== "Quiesce") return
  const runtime = yield* Runtime
  const crypto = yield* Crypto.Crypto
  const access = yield* runtime.access.pipe(Effect.mapError(hostFailure))
  if (
    access.fence.assignmentId !== message.fence.assignmentId ||
    access.fence.assignmentGeneration !== message.fence.assignmentGeneration ||
    access.fence.instanceId !== message.fence.instanceId ||
    access.fence.executorId !== message.fence.executorId
  )
    return yield* HostError.make({ message: "Quiesce request has a stale executor fence" })
  yield* Ref.set(dependencies.quiesced, true)
  yield* dependencies.operationLifecycle.quiesce.pipe(Effect.mapError(hostFailure))
  const checkpointId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(hostFailure))
  const archive = encodeArchive(
    yield* createArchive(yield* functions.workspaceRoot, dependencies.redactedValues).pipe(
      Effect.mapError(hostFailure),
    ),
  )
  const cursor = yield* runtime.cursor.pipe(Effect.mapError(hostFailure))
  yield* dependencies
    .writer(
      functions.encode({
        _tag: "ExecutorQuiesced",
        access,
        requestId: message.requestId,
        checkpoint: { version: 1, checkpointId, archive, cursor },
      }),
    )
    .pipe(Effect.mapError(hostFailure))
})

const consumeMessage = Effect.fn("Host.consumeApiMessage")(function* (
  message: IncomingMessage,
  dependencies: ApiDispatchDependencies,
  functions: ApiDispatchFunctions,
) {
  if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
  yield* consumeReceipt(message, dependencies, functions)
  if (yield* functions.dispatchPty(message, dependencies.writer, dependencies.ptyDelivery)) return
  if (yield* functions.dispatchWorkspace(message, dependencies.writer)) return
  if (message._tag === "PhaseEnvironmentGranted")
    yield* functions.applyPhaseGrant(
      message,
      dependencies.grants,
      dependencies.executionEnvironment,
      dependencies.environmentAccess,
      dependencies.redactedValues,
    )
  yield* consumeBranchPush(message, dependencies, functions)
  yield* consumeOperation(message, dependencies)
  yield* consumeQuiesce(message, dependencies, functions)
})

const makeConsumeApi = (functions: ApiDispatchFunctions) => (dependencies: ApiDispatchDependencies) =>
  Effect.forever(
    Effect.flatMap(Queue.take(dependencies.incoming), (message) => consumeMessage(message, dependencies, functions)),
  )

export const apiDispatch = { consume: makeConsumeApi } as const
