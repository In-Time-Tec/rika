import {
  type ClientCommand,
  type ClientMessage,
  hostedThreadSnapshotMatches,
  HostedThreadSnapshot,
  interactiveEventThreadId,
  type MutatingThreadCommand,
  protocolVersion,
  type ServerFrame,
} from "@rika/product/client-protocol"
import {
  CommandId,
  IdempotencyKey,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
} from "@rika/product/hosted-model"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import * as HostedObservability from "@rika/product/hosted-observability"
import { OperationUnavailable } from "@rika/product/product-operation"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import { CredentialStore, HostedError, Http, ProfileStore, type Profile } from "./contract"
import { authenticated } from "./account"
import { connect } from "./thread-client"
import { Crypto, Deferred, Effect, Exit, Option, Queue, Schema, Semaphore, SubscriptionRef } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

type Payload = ServerFrame["payload"]
type Admitted = Extract<Payload, { readonly _tag: "CommandAdmitted" }>
type Accepted = Extract<Payload, { readonly _tag: "CommandAccepted" }>
type Rejected = Extract<Payload, { readonly _tag: "CommandRejected" }>
type Snapshot = Extract<Payload, { readonly _tag: "ThreadSnapshot" }>
type Attachment = Extract<Payload, { readonly _tag: "ThreadAttached" }>
type Preview = Extract<Payload, { readonly _tag: "ThreadPreview" }>
type SnapshotProjection = Pick<Snapshot, "threadId" | "threadVersion" | "cursor" | "snapshot">
type CancellationTarget = Extract<MutatingThreadCommand, { readonly _tag: "Cancel" }>["target"]
type Mutable<T> = { -readonly [P in keyof T]: T[P] }
type SubmitPromptCommand = Mutable<Extract<ClientCommand, { readonly _tag: "SubmitPrompt" }>>
type SubmitPromptAttachment = NonNullable<SubmitPromptCommand["attachments"]>[number]
const encodeThreadView = Schema.encodeSync(Schema.fromJsonString(ThreadView.ThreadViewSnapshot))
type CommandOutcome = Admitted | Accepted | Rejected

const failure = (message: string) => HostedError.make({ kind: "network", message })
const protocolFailure = (message: string) => HostedError.make({ kind: "protocol", message })
type PreparedAttachment = {
  readonly attachment: Attachment
  readonly snapshotCursor: bigint
  readonly terminalCursor: bigint
  readonly view: ThreadView.ThreadViewSnapshot
}
type Projection = {
  readonly threadId: string
  readonly view: ThreadView.ThreadViewSnapshot
  readonly authorizations: ReadonlyMap<string, HostedThreadSnapshot["pendingAuthorizations"][number]>
  readonly target: "runner" | "orb"
  readonly activity: InteractiveConnection.Activity
  readonly participants: number
  readonly committedCursor: string
  readonly version: string
  readonly deliveredCursor: string
  readonly deliveredFingerprint: string | undefined
}
type SelectionState =
  | { readonly _tag: "Attached"; readonly projection: Projection }
  | {
      readonly _tag: "Loading"
      readonly token: object
      readonly threadId: string
      readonly authority: Projection | undefined
    }
type AttachmentValidation =
  | { readonly _tag: "Invalid"; readonly error: HostedError }
  | { readonly _tag: "Valid"; readonly prepared: PreparedAttachment }

const prepareAttachment = (attachment: Attachment): AttachmentValidation => {
  const threadId = String(attachment.threadId)
  if (!hostedThreadSnapshotMatches(attachment.snapshot, threadId))
    return { _tag: "Invalid", error: failure("Hosted Thread attachment snapshot identity did not match its response") }
  if (
    attachment.events.some((event) => {
      const eventThreadId = interactiveEventThreadId(event.event)
      return String(event.threadId) !== threadId || (eventThreadId !== undefined && eventThreadId !== threadId)
    })
  )
    return { _tag: "Invalid", error: failure("Hosted Thread attachment event identity did not match its response") }
  const snapshotCursor = BigInt(attachment.snapshotCursor)
  const terminalCursor = BigInt(attachment.cursor)
  if (snapshotCursor > terminalCursor)
    return { _tag: "Invalid", error: failure("Hosted Thread attachment snapshot exceeded its terminal cursor") }
  let expectedCursor = snapshotCursor + 1n
  let representedVersion = BigInt(attachment.snapshotThreadVersion)
  for (const event of attachment.events) {
    if (BigInt(event.cursor) !== expectedCursor)
      return { _tag: "Invalid", error: failure("Hosted Thread attachment replay was not contiguous") }
    const eventVersion = BigInt(event.threadVersion)
    if (eventVersion < representedVersion)
      return { _tag: "Invalid", error: failure("Hosted Thread attachment version regressed") }
    representedVersion = eventVersion
    expectedCursor += 1n
  }
  if (expectedCursor - 1n !== terminalCursor || representedVersion !== BigInt(attachment.threadVersion))
    return { _tag: "Invalid", error: failure("Hosted Thread attachment terminal metadata was not represented") }
  let view = ThreadView.fromSnapshot(attachment.snapshot.view)
  if (view._tag === "Failure")
    return { _tag: "Invalid", error: failure("Hosted Thread attachment snapshot was invalid") }
  for (const event of attachment.events) {
    if (event.event._tag === "ThreadViewSnapshot") {
      view = ThreadView.fromSnapshot(event.event.snapshot)
      if (view._tag === "Failure")
        return { _tag: "Invalid", error: failure("Hosted Thread attachment view snapshot was invalid") }
    } else if (event.event._tag === "ThreadViewPatch") {
      const applied = view.success.apply(event.event.patch)
      if (applied._tag === "Failure")
        return { _tag: "Invalid", error: failure("Hosted Thread attachment view patch was invalid") }
    }
  }
  return {
    _tag: "Valid",
    prepared: { attachment, snapshotCursor, terminalCursor, view: view.success.snapshot() },
  }
}
const ErrorMessage = Schema.Struct({ message: Schema.String })
const unavailable = <E>(operation: string, error: E) => {
  const parsed = Schema.decodeUnknownOption(ErrorMessage)(error)
  return OperationUnavailable.make({
    operation,
    message: Option.isSome(parsed) ? parsed.value.message : String(error),
  })
}

export const threadViewFromHostedSnapshot = (snapshot: HostedThreadSnapshot): ThreadView.ThreadViewSnapshot =>
  snapshot.view

const envelope = (requestId: string, command: ClientCommand): ClientMessage => ({
  protocolVersion,
  requestId: RequestId.make(requestId),
  command,
})

interface PhysicalConnection {
  readonly command: (
    requestId: string,
    command: ClientCommand,
    completeOnAdmission: boolean,
    onSending?: Effect.Effect<void>,
    onRejected?: (outcome: Rejected) => Effect.Effect<void>,
  ) => Effect.Effect<CommandOutcome, HostedError>
  readonly acknowledge: (requestId: string, threadId: string, cursor: string) => Effect.Effect<void, HostedError>
  readonly attach: (threadId: string, cursor: string) => Effect.Effect<PendingAttachment, HostedError>
  readonly invalidate: Effect.Effect<void>
  readonly detach: Effect.Effect<void, HostedError>
  readonly done: Effect.Effect<never, HostedError>
}

interface PendingAttachment {
  readonly attachment: Attachment
  readonly complete: Effect.Effect<void>
  readonly fail: (error: HostedError) => Effect.Effect<void>
}

interface AttachmentWaiter {
  readonly response: Deferred.Deferred<Attachment, HostedError>
  readonly processed: Deferred.Deferred<void, HostedError>
}

interface CommandWaiter {
  readonly outcomes: Queue.Queue<CommandOutcome>
  readonly command: ClientCommand
  readonly onRejected: (outcome: Rejected) => Effect.Effect<void>
}

interface PendingSubmission {
  readonly commandId: Deferred.Deferred<string, OperationUnavailable>
  sending: boolean
}

const makePhysicalConnection = Effect.fn("HostedInteractiveSession.physical")(function* (input: {
  readonly profile: Profile
  readonly threadId: () => string
  readonly cursor: (threadId: string) => string
  readonly resolving: () => boolean
  readonly opening: (connection: PhysicalConnection) => Effect.Effect<void>
  readonly receive: (payload: Payload, connection: PhysicalConnection) => Effect.Effect<void, HostedError>
  readonly attached: (attachment: Attachment, connection: PhysicalConnection) => Effect.Effect<void, HostedError>
  readonly processed: (attachment: Attachment, connection: PhysicalConnection) => Effect.Effect<void>
}) {
  const http = yield* Http
  const credentials = yield* CredentialStore
  const crypto = yield* Crypto.Crypto
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("Hosted Thread request identifier could not be created")),
  )
  const ticket = yield* authenticated(input.profile, (session) =>
    http.issueThreadTicket(input.profile.origin, session),
  ).pipe(Effect.provideService(Http, http), Effect.provideService(CredentialStore, credentials))
  const socket = yield* connect(ticket)
  const outcomes = new Map<string, CommandWaiter>()
  const attachments = new Map<string, AttachmentWaiter>()
  const disconnected = yield* Deferred.make<never, HostedError>()
  const failPending = (error: HostedError) =>
    Effect.sync(() => {
      for (const waiter of attachments.values()) {
        Deferred.doneUnsafe(waiter.response, Effect.fail(error))
        Deferred.doneUnsafe(waiter.processed, Effect.fail(error))
      }
      outcomes.clear()
      attachments.clear()
      Deferred.doneUnsafe(disconnected, Effect.fail(error))
    })
  let physical: PhysicalConnection
  const command = (
    requestId: string,
    value: ClientCommand,
    completeOnAdmission: boolean,
    onSending = Effect.void,
    onRejected: (outcome: Rejected) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const waiter: CommandWaiter = {
        outcomes: yield* Queue.bounded<CommandOutcome>(2),
        command: value,
        onRejected,
      }
      outcomes.set(requestId, waiter)
      yield* Effect.uninterruptible(
        onSending.pipe(
          Effect.andThen(
            socket
              .send(envelope(requestId, value))
              .pipe(Effect.onError(() => Effect.sync(() => outcomes.delete(requestId)))),
          ),
        ),
      )
      const next = Queue.take(waiter.outcomes).pipe(Effect.raceFirst(Deferred.await(disconnected)))
      let outcome = yield* next
      if (outcome._tag === "CommandAdmitted" && !completeOnAdmission) outcome = yield* next
      return outcome
    }).pipe(Effect.ensuring(Effect.sync(() => outcomes.delete(requestId))))
  const attach = (threadId: string, cursor: string) =>
    Effect.gen(function* () {
      const requestId = `attach:${threadId}:${yield* randomId}`
      const waiter = {
        response: yield* Deferred.make<Attachment, HostedError>(),
        processed: yield* Deferred.make<void, HostedError>(),
      }
      attachments.set(requestId, waiter)
      yield* socket
        .send(
          envelope(requestId, {
            _tag: "AttachThread",
            threadId: ThreadId.make(threadId),
            afterCursor: ThreadEventCursor.make(cursor),
          }),
        )
        .pipe(Effect.onError(() => Effect.sync(() => attachments.delete(requestId))))
      const attachment = yield* Deferred.await(waiter.response).pipe(
        Effect.ensuring(Effect.sync(() => attachments.delete(requestId))),
      )
      if (String(attachment.threadId) !== threadId) {
        const error = failure("Hosted Thread attachment response identity did not match its request")
        yield* Deferred.fail(waiter.processed, error)
        yield* failPending(error)
        return yield* error
      }
      return {
        attachment,
        complete: Deferred.succeed(waiter.processed, undefined).pipe(Effect.asVoid),
        fail: (error: HostedError) => Deferred.fail(waiter.processed, error).pipe(Effect.asVoid),
      }
    })
  physical = {
    command,
    acknowledge: (requestId, threadId, cursor) =>
      socket.send(
        envelope(requestId, {
          _tag: "AcknowledgeCursor",
          threadId: ThreadId.make(threadId),
          cursor: ThreadEventCursor.make(cursor),
        }),
      ),
    attach,
    invalidate: failPending(failure("Hosted Thread attachment was invalidated")),
    detach: Effect.gen(function* () {
      yield* socket.send(envelope(`detach:${yield* randomId}`, { _tag: "Detach" }))
    }),
    done: Deferred.await(disconnected),
  }
  yield* Effect.gen(function* () {
    while (true) {
      const frame = yield* socket.next
      const payload = frame.payload
      yield* input.receive(payload, physical)
      if (payload._tag === "ThreadAttached") {
        const waiter = attachments.get(payload.requestId)
        if (waiter === undefined) return yield* failure("Hosted Thread attachment response was not requested")
        yield* Deferred.succeed(waiter.response, payload)
        yield* Deferred.await(waiter.processed)
      } else if (
        payload._tag === "CommandAdmitted" ||
        payload._tag === "CommandAccepted" ||
        payload._tag === "CommandRejected"
      ) {
        const waiter = outcomes.get(payload.requestId)
        if (waiter !== undefined) {
          if ("threadId" in waiter.command && String(payload.threadId) !== String(waiter.command.threadId)) {
            const error = protocolFailure("Hosted Thread response identity did not match its command")
            yield* failPending(error)
            return yield* error
          }
          if (
            "commandId" in waiter.command &&
            (payload.commandId === undefined || String(payload.commandId) !== String(waiter.command.commandId))
          ) {
            const error = protocolFailure("Hosted Thread response command identity did not match its command")
            yield* failPending(error)
            return yield* error
          }
          if (payload._tag === "CommandRejected") yield* Effect.uninterruptible(waiter.onRejected(payload))
          yield* Queue.offer(waiter.outcomes, payload)
        }
        if (payload._tag === "CommandRejected") {
          const attachmentWaiter = attachments.get(payload.requestId)
          if (attachmentWaiter !== undefined) {
            const error = HostedError.make({ kind: "protocol", message: payload.message })
            yield* Deferred.fail(attachmentWaiter.response, error)
            yield* Deferred.fail(attachmentWaiter.processed, error)
          }
        }
      }
    }
  }).pipe(
    Effect.catch((error) => failPending(error)),
    Effect.ensuring(failPending(failure("Hosted Thread connection closed"))),
    Effect.forkScoped,
  )
  yield* input.opening(physical)
  const initialThreadId = input.threadId()
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const attachment = HostedObservability.observe(
        "attach",
        { threadId: initialThreadId },
        Effect.gen(function* () {
          const pending = yield* restore(physical.attach(initialThreadId, input.cursor(initialThreadId)))
          yield* input.attached(pending.attachment, physical).pipe(
            Effect.andThen(input.processed(pending.attachment, physical)),
            Effect.andThen(pending.complete),
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? pending
                    .fail(failure("Hosted Thread attachment processing did not complete"))
                    .pipe(Effect.andThen(physical.invalidate))
                : Effect.void,
            ),
          )
        }),
      )
      return input.resolving()
        ? HostedObservability.observe("target_resolution", { threadId: initialThreadId }, attachment)
        : attachment
    }),
  )
  return physical
})

export interface HostedInteractiveSession {
  readonly session: InteractiveSession
  readonly connection: InteractiveConnection.Connection
}

export const makeHostedInteractiveSession = Effect.fn("HostedInteractiveSession.make")(function* (input: {
  readonly profile: Profile
  readonly threadId: string
  readonly createThread: (executorKind: "runner" | "orb") => Effect.Effect<string, HostedError>
}) {
  const profile = input.profile
  const http = yield* Http
  const credentials = yield* CredentialStore
  const profiles = yield* ProfileStore
  const crypto = yield* Crypto.Crypto
  const webSocket = yield* Socket.WebSocketConstructor
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("Hosted Thread request identifier could not be created")),
  )
  const selectionAdmission = yield* Semaphore.make(1)
  const initialState: InteractiveConnection.State = {
    connectivity: "connecting",
    target: "resolving",
    participants: 0,
  }
  const state = yield* SubscriptionRef.make(initialState)
  const closed = yield* Deferred.make<void>()
  let selection: SelectionState = {
    _tag: "Loading",
    token: {},
    threadId: input.threadId,
    authority: undefined,
  }
  let dispatch: (event: InteractiveEvent) => void = () => undefined
  let consumerAttached = false
  let stopped = false
  let current: PhysicalConnection | undefined
  let connecting: PhysicalConnection | undefined
  const latestSubmitCommandIds = new Map<string, string>()
  const pendingSubmitCommandIds = new Map<string, Map<string, PendingSubmission>>()
  const threadCursors = new Map<string, string>()
  const activePreviews = new Map<string, Preview>()
  let connectionChanged = Deferred.makeUnsafe<void>()
  const updateState = (update: (previousState: InteractiveConnection.State) => InteractiveConnection.State) =>
    SubscriptionRef.updateSome(state, (previousState) => {
      const next = update(previousState)
      return next === previousState ? Option.none() : Option.some(next)
    })
  const setActivity = (activity: InteractiveConnection.Activity) =>
    updateState((previousState) =>
      previousState.activity === activity ? previousState : { ...previousState, activity },
    )
  const setParticipants = (participants: number) =>
    updateState((previousState) =>
      previousState.participants === participants ? previousState : { ...previousState, participants },
    )

  const publishConnection = (value: PhysicalConnection | undefined) => {
    current = value
    connecting = undefined
    Deferred.doneUnsafe(connectionChanged, Effect.void)
    connectionChanged = Deferred.makeUnsafe<void>()
  }
  const awaitConnection: Effect.Effect<PhysicalConnection, HostedError> = Effect.suspend(() => {
    if (stopped) return Effect.fail(failure("Hosted interactive session is closed"))
    return current === undefined
      ? Deferred.await(connectionChanged).pipe(Effect.andThen(awaitConnection))
      : Effect.succeed(current)
  })
  const acknowledge = (connection: PhysicalConnection, threadId: string, cursor: string) =>
    Effect.gen(function* () {
      const requestId = `ack:${threadId}:${cursor}:${yield* randomId}`
      yield* connection.acknowledge(requestId, threadId, cursor)
    }).pipe(Effect.ignore)
  const authority = () => (selection._tag === "Attached" ? selection.projection : selection.authority)
  const registerPendingSubmitCommandId = (threadId: string, submissionId: string) => {
    let threadSubmissions = pendingSubmitCommandIds.get(threadId)
    if (threadSubmissions === undefined) {
      threadSubmissions = new Map()
      pendingSubmitCommandIds.set(threadId, threadSubmissions)
    }
    const existing = threadSubmissions.get(submissionId)
    if (existing !== undefined) return undefined
    const created: PendingSubmission = {
      commandId: Deferred.makeUnsafe<string, OperationUnavailable>(),
      sending: false,
    }
    threadSubmissions.set(submissionId, created)
    return created
  }
  const markPendingSubmissionSending = (threadId: string, submissionId: string) =>
    Effect.sync(() => {
      const pending = pendingSubmitCommandIds.get(threadId)?.get(submissionId)
      if (pending !== undefined) pending.sending = true
    })
  const forgetPendingSubmitCommandId = (threadId: string, submissionId: string) =>
    Effect.sync(() => {
      const threadSubmissions = pendingSubmitCommandIds.get(threadId)
      threadSubmissions?.delete(submissionId)
      if (threadSubmissions?.size === 0) pendingSubmitCommandIds.delete(threadId)
    })
  const forgetUnsentSubmission = (threadId: string, submissionId: string) =>
    Effect.sync(() => {
      const threadSubmissions = pendingSubmitCommandIds.get(threadId)
      if (threadSubmissions?.get(submissionId)?.sending !== false) return
      threadSubmissions.delete(submissionId)
      if (threadSubmissions.size === 0) pendingSubmitCommandIds.delete(threadId)
    })
  const reconcilePendingSubmissions = (prepared: PreparedAttachment) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const threadId = String(prepared.attachment.threadId)
        for (const event of prepared.attachment.events)
          if (
            (event.event._tag === "SubmissionAdmitted" || event.event._tag === "SubmissionRejected") &&
            event.event.submissionId !== undefined
          )
            yield* forgetPendingSubmitCommandId(threadId, event.event.submissionId)
      }),
    )
  const activeTurnId = () =>
    authority()?.view.turns.findLast(
      (entry) =>
        entry.turn.status === "accepted" ||
        entry.turn.status === "running" ||
        entry.turn.status === "cancelling" ||
        entry.turn.status === "waiting",
    )?.turn.id
  const replaceAuthority = (expected: Projection, replacement: Projection) => {
    if (selection._tag === "Attached" && selection.projection === expected) {
      selection = { _tag: "Attached", projection: replacement }
      return true
    }
    if (selection._tag === "Loading" && selection.authority === expected) {
      selection = { ...selection, authority: replacement }
      return true
    }
    return false
  }
  const selectedFrame = (threadId: string) =>
    selection._tag === "Attached" ? selection.projection.threadId === threadId : selection.threadId === threadId
  const currentFrame = (connection: PhysicalConnection) => current === connection || connecting === connection
  const resetPreviews = (threadId: string) => {
    for (const [key, payload] of activePreviews) {
      if (String(payload.threadId) !== threadId) continue
      dispatch({
        _tag: "ExecutionModelPreviewChanged",
        threadId: ProductThreadId.make(payload.threadId),
        turnId: payload.turnId,
        preview:
          payload.preview.parentId === undefined
            ? {
                _tag: "ModelPreviewCleared",
                runId: payload.preview.runId,
                attemptFence: payload.preview.attemptFence,
                generation: 0,
              }
            : {
                _tag: "ModelPreviewCleared",
                runId: payload.preview.runId,
                parentId: payload.preview.parentId,
                attemptFence: payload.preview.attemptFence,
                generation: 0,
              },
      })
      activePreviews.delete(key)
    }
  }
  const projectionActivity = (
    view: ThreadView.ThreadViewSnapshot,
    pendingAuthorizations: ReadonlyArray<unknown>,
    executorKind: HostedThreadSnapshot["executorKind"],
    workspace: HostedThreadSnapshot["workspace"],
  ): InteractiveConnection.Activity => {
    const active = view.turns
    if (pendingAuthorizations.length > 0) return "approval-required"
    if (
      active.length > 0 &&
      active.every(
        (entry) =>
          entry.turn.status === "completed" || entry.turn.status === "failed" || entry.turn.status === "cancelled",
      )
    )
      return "terminal"
    if (active.length > 0 && executorKind === "orb" && workspace?._tag === "OrbWorkspace") {
      if (workspace.state === "preparing") return "workspace-preparing"
      if (workspace.state === "failed") return "workspace-failed"
    }
    if (active.some((entry) => entry.turn.status === "waiting")) return "executor-waiting"
    if (active.some((entry) => entry.turn.status === "running" || entry.turn.status === "cancelling"))
      return "executor-connected"
    return "executor-waiting"
  }
  const projectionFromSnapshot = (
    payload: SnapshotProjection,
    participants: number,
    deliveredCursor: string,
    deliveredFingerprint: string | undefined,
  ): Projection | HostedError => {
    const view = ThreadView.fromSnapshot(payload.snapshot.view)
    if (view._tag === "Failure") return failure("Hosted Thread snapshot view was invalid")
    return {
      threadId: String(payload.threadId),
      view: view.success.snapshot(),
      authorizations: new Map(
        payload.snapshot.pendingAuthorizations.map((pending) => [
          `${pending.turnId}:${pending.authorizationId}`,
          pending,
        ]),
      ),
      target: payload.snapshot.executorKind,
      activity: projectionActivity(
        payload.snapshot.view,
        payload.snapshot.pendingAuthorizations,
        payload.snapshot.executorKind,
        payload.snapshot.workspace,
      ),
      participants,
      committedCursor: String(payload.cursor),
      version: String(payload.threadVersion),
      deliveredCursor,
      deliveredFingerprint,
    }
  }
  const publishProjectionState = (projection: Projection) =>
    updateState((previousState) =>
      previousState.target === projection.target &&
      previousState.activity === projection.activity &&
      previousState.participants === projection.participants
        ? previousState
        : {
            ...previousState,
            target: projection.target,
            activity: projection.activity,
            participants: projection.participants,
          },
    )
  const commitSnapshot = (payload: Snapshot, connection: PhysicalConnection) =>
    Effect.gen(function* () {
      const threadId = String(payload.threadId)
      if (!selectedFrame(threadId)) return
      if (!hostedThreadSnapshotMatches(payload.snapshot, threadId))
        return yield* failure("Hosted Thread snapshot identity did not match its response")
      const previous = authority()!
      const cursor = BigInt(payload.cursor)
      const previousCursor = BigInt(previous.committedCursor)
      if (cursor < previousCursor) return
      if (BigInt(payload.threadVersion) < BigInt(previous.version))
        return yield* failure("Hosted Thread snapshot version regressed")
      const candidate = projectionFromSnapshot(
        payload,
        previous.participants,
        previous.deliveredCursor,
        previous.deliveredFingerprint,
      )
      if (Schema.is(HostedError)(candidate)) return yield* candidate
      const fingerprint = encodeThreadView(payload.snapshot.view)
      if (!replaceAuthority(previous, candidate)) return
      yield* publishProjectionState(candidate)
      if (previous.deliveredFingerprint !== fingerprint)
        dispatch({ _tag: "ThreadViewSnapshot", snapshot: threadViewFromHostedSnapshot(payload.snapshot) })
      replaceAuthority(candidate, {
        ...candidate,
        deliveredCursor: candidate.committedCursor,
        deliveredFingerprint: fingerprint,
      })
      threadCursors.set(threadId, candidate.committedCursor)
      yield* acknowledge(connection, threadId, String(payload.cursor))
    })
  const planAttachment = (prepared: PreparedAttachment, previous: Projection | undefined) => {
    const threadId = String(prepared.attachment.threadId)
    const continuing = previous?.threadId === threadId
    const deliveredCursor = continuing ? previous.deliveredCursor : (threadCursors.get(threadId) ?? "0")
    const currentCursor = BigInt(deliveredCursor)
    if (currentCursor > prepared.terminalCursor)
      return {
        _tag: "Invalid" as const,
        error: failure("Hosted Thread attachment terminal cursor regressed"),
      }
    const view = ThreadView.fromSnapshot(prepared.view)
    if (view._tag === "Failure")
      return { _tag: "Invalid" as const, error: failure("Hosted Thread committed view was invalid") }
    const payload = prepared.attachment
    const candidate: Projection = {
      threadId,
      view: view.success.snapshot(),
      authorizations: new Map(
        payload.snapshot.pendingAuthorizations.map((pending) => [
          `${pending.turnId}:${pending.authorizationId}`,
          pending,
        ]),
      ),
      target: payload.snapshot.executorKind,
      activity: projectionActivity(
        prepared.view,
        payload.snapshot.pendingAuthorizations,
        payload.snapshot.executorKind,
        payload.snapshot.workspace,
      ),
      participants: payload.participants.length,
      committedCursor: String(payload.cursor),
      version: String(payload.threadVersion),
      deliveredCursor,
      deliveredFingerprint: continuing ? previous.deliveredFingerprint : undefined,
    }
    return {
      _tag: "Valid" as const,
      publishSnapshot: previous?.deliveredFingerprint !== encodeThreadView(prepared.view),
      candidate,
    }
  }
  const publishAttachment = (
    prepared: PreparedAttachment,
    plan: Extract<ReturnType<typeof planAttachment>, { readonly _tag: "Valid" }>,
  ) =>
    Effect.sync(() => {
      if (plan.publishSnapshot) dispatch({ _tag: "ThreadViewSnapshot", snapshot: prepared.view })
      return encodeThreadView(prepared.view)
    })
  const commitInitialAttachment = (attachment: Attachment) =>
    Effect.gen(function* () {
      const validation = prepareAttachment(attachment)
      if (validation._tag === "Invalid") return yield* validation.error
      const threadId = String(validation.prepared.attachment.threadId)
      const plan = planAttachment(validation.prepared, authority())
      if (plan._tag === "Invalid") return yield* plan.error
      yield* reconcilePendingSubmissions(validation.prepared)
      const bootstrap = selection._tag === "Loading" && selection.authority === undefined
      selection =
        selection._tag === "Loading" && !bootstrap
          ? { ...selection, authority: plan.candidate }
          : { _tag: "Attached", projection: plan.candidate }
      yield* publishProjectionState(plan.candidate)
      const fingerprint = yield* publishAttachment(validation.prepared, plan)
      const delivered = {
        ...plan.candidate,
        deliveredCursor: plan.candidate.committedCursor,
        deliveredFingerprint: fingerprint,
      }
      replaceAuthority(plan.candidate, delivered)
      threadCursors.set(threadId, delivered.deliveredCursor)
    })
  const receive = (payload: Payload, connection: PhysicalConnection) =>
    Effect.gen(function* () {
      if (payload._tag === "ThreadPreview" || payload._tag === "ThreadPreviewReset") {
        const threadId = String(payload.threadId)
        if (!currentFrame(connection) || !selectedFrame(threadId)) return
        if (payload._tag === "ThreadPreviewReset") {
          resetPreviews(threadId)
          return
        }
        const key = `${threadId}:${payload.turnId}:${payload.preview.runId}`
        if (payload.preview._tag === "ModelPreview") activePreviews.set(key, payload)
        else activePreviews.delete(key)
        dispatch({
          _tag: "ExecutionModelPreviewChanged",
          threadId: ProductThreadId.make(payload.threadId),
          turnId: payload.turnId,
          preview: payload.preview,
        })
        return
      }
      if (payload._tag === "PresenceSnapshot") {
        if (!currentFrame(connection) || !selectedFrame(String(payload.threadId))) return
        const projection = authority()!
        replaceAuthority(projection, { ...projection, participants: payload.participants.length })
        yield* setParticipants(payload.participants.length)
        return
      }
      if (payload._tag === "ThreadSnapshot") {
        if (payload.requestId === undefined && currentFrame(connection)) yield* commitSnapshot(payload, connection)
        return
      }
      if (payload._tag === "ThreadEvent") {
        const threadId = String(payload.event.threadId)
        if (!currentFrame(connection) || !selectedFrame(threadId)) return
        const eventThreadId = interactiveEventThreadId(payload.event.event)
        if (eventThreadId !== undefined && eventThreadId !== threadId)
          return yield* failure("Hosted Thread event identity did not match its response")
        const next = BigInt(payload.event.cursor)
        const projection = authority()!
        const previous = BigInt(projection.committedCursor)
        if (next <= previous) return
        if (next !== previous + 1n) return yield* failure("Hosted Thread event cursor was not contiguous")
        if (BigInt(payload.event.threadVersion) < BigInt(projection.version))
          return yield* failure("Hosted Thread event version regressed")
        if (
          (payload.event.event._tag === "SubmissionAdmitted" || payload.event.event._tag === "SubmissionRejected") &&
          payload.event.event.submissionId !== undefined
        )
          yield* Effect.uninterruptible(forgetPendingSubmitCommandId(threadId, payload.event.event.submissionId))
        let nextView = projection.view
        if (payload.event.event._tag === "ThreadViewSnapshot") {
          const view = ThreadView.fromSnapshot(payload.event.event.snapshot)
          if (view._tag === "Failure") return yield* failure("Hosted Thread event snapshot was invalid")
          nextView = view.success.snapshot()
        } else if (payload.event.event._tag === "ThreadViewPatch") {
          const candidate = ThreadView.fromSnapshot(projection.view)
          if (candidate._tag === "Failure") return yield* failure("Hosted Thread event view was invalid")
          const applied = candidate.success.apply(payload.event.event.patch)
          if (applied._tag === "Failure") return yield* failure("Hosted Thread event patch was invalid")
          nextView = candidate.success.snapshot()
        }
        const candidate: Projection = {
          ...projection,
          view: nextView,
          version: String(payload.event.threadVersion),
          committedCursor: String(payload.event.cursor),
        }
        if (!replaceAuthority(projection, candidate)) return
        dispatch(payload.event.event)
        replaceAuthority(candidate, {
          ...candidate,
          deliveredCursor: candidate.committedCursor,
          deliveredFingerprint: encodeThreadView(nextView),
        })
        threadCursors.set(threadId, candidate.committedCursor)
        yield* acknowledge(connection, threadId, String(payload.event.cursor))
      }
    })

  const attachSelection = (request: { readonly threadId: string; readonly token: object }, expected?: string) =>
    selectionAdmission.withPermits(1)(
      HostedObservability.observe(
        "attach",
        { threadId: request.threadId },
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const threadId = request.threadId
            if (expected !== undefined && threadId !== expected)
              return yield* failure("Queue refresh requires the selected Thread")
            if (selection._tag !== "Loading" || selection.token !== request.token || selection.threadId !== threadId)
              return yield* failure("Thread selection was superseded")
            const previous = selection.authority
            if (threadId !== previous?.threadId) {
              yield* updateState(({ activity: _, ...previousState }) => ({
                ...previousState,
                target: "resolving",
                participants: 0,
              }))
            }
            let physical: PhysicalConnection | undefined
            let pending: PendingAttachment | undefined
            const outcome = yield* restore(
              awaitConnection.pipe(
                Effect.tap((connection) =>
                  Effect.sync(() => {
                    physical = connection
                  }),
                ),
                Effect.flatMap((connection) =>
                  connection.attach(
                    threadId,
                    previous?.threadId === threadId ? previous.deliveredCursor : (threadCursors.get(threadId) ?? "0"),
                  ),
                ),
              ),
            ).pipe(Effect.exit)
            if (outcome._tag === "Success") pending = outcome.value
            let preparedCandidate: Projection | undefined
            yield* Effect.gen(function* () {
              const superseded =
                outcome._tag === "Success" &&
                (physical === undefined ||
                  current !== physical ||
                  selection._tag !== "Loading" ||
                  selection.token !== request.token ||
                  selection.threadId !== threadId)
              const validation = outcome._tag === "Success" ? prepareAttachment(outcome.value.attachment) : undefined
              const currentAuthority =
                selection._tag === "Loading" && selection.token === request.token ? selection.authority : undefined
              const plan =
                validation?._tag === "Valid" ? planAttachment(validation.prepared, currentAuthority) : undefined
              let invalid: HostedError | undefined
              if (validation?._tag === "Invalid") invalid = validation.error
              else if (plan?._tag === "Invalid") invalid = plan.error
              else if (superseded) invalid = failure("Thread selection was superseded")
              if (outcome._tag === "Failure" || invalid !== undefined) {
                if (pending !== undefined && invalid !== undefined) yield* pending.fail(invalid)
                if (outcome._tag === "Failure") return yield* Effect.failCause(outcome.cause)
                return yield* invalid ?? failure("Thread selection attachment was invalid")
              }
              if (
                validation === undefined ||
                validation._tag !== "Valid" ||
                plan === undefined ||
                plan._tag !== "Valid"
              )
                return yield* failure("Thread selection attachment was not valid")
              const prepared = validation.prepared
              const committedPlan = plan
              yield* reconcilePendingSubmissions(prepared)
              preparedCandidate = committedPlan.candidate
              if (currentAuthority === undefined || !replaceAuthority(currentAuthority, preparedCandidate))
                return yield* failure("Thread selection was superseded")
              yield* publishProjectionState(committedPlan.candidate)
              const fingerprint = yield* publishAttachment(prepared, committedPlan)
              const delivered = {
                ...committedPlan.candidate,
                deliveredCursor: committedPlan.candidate.committedCursor,
                deliveredFingerprint: fingerprint,
              }
              if (
                selection._tag !== "Loading" ||
                selection.token !== request.token ||
                selection.authority !== committedPlan.candidate
              )
                return yield* failure("Thread selection was superseded")
              selection = { _tag: "Attached", projection: delivered }
              threadCursors.set(threadId, delivered.deliveredCursor)
              if (
                previous?.threadId !== threadId ||
                previous.deliveredCursor !== committedPlan.candidate.committedCursor
              )
                yield* acknowledge(physical!, threadId, committedPlan.candidate.committedCursor)
              yield* pending!.complete
            }).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) return Effect.void
                return Effect.gen(function* () {
                  if (pending !== undefined)
                    yield* pending.fail(failure("Hosted Thread attachment processing did not complete"))
                  if (physical !== undefined) {
                    if (current === physical) publishConnection(undefined)
                    yield* physical.invalidate
                  }
                  if (selection._tag === "Loading" && selection.token === request.token) {
                    const retained = preparedCandidate ?? previous
                    if (retained !== undefined) selection = { _tag: "Attached", projection: retained }
                  }
                })
              }),
            )
          }),
        ),
      ),
    )
  const requestSelection = (threadId: string, refreshAuthority?: Projection) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (
          refreshAuthority !== undefined &&
          (selection._tag !== "Attached" || selection.projection !== refreshAuthority)
        )
          return Effect.void
        const previous = authority()
        const request = { threadId, token: {} }
        if (previous !== undefined && previous.threadId !== threadId) resetPreviews(previous.threadId)
        selection = { _tag: "Loading", ...request, authority: previous }
        const attachment = attachSelection(request)
        const resolution =
          previous?.threadId === threadId
            ? attachment
            : HostedObservability.observe("target_resolution", { threadId }, attachment)
        return restore(resolution).pipe(
          Effect.onExit((exit) => {
            if (
              Exit.isSuccess(exit) ||
              selection._tag !== "Loading" ||
              selection.token !== request.token ||
              previous === undefined
            )
              return Effect.void
            selection = { _tag: "Attached", projection: previous }
            return publishProjectionState(previous)
          }),
        )
      }),
    )

  const superviseConnection = (connectedBefore: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (stopped) return Effect.void
      let established = connectedBefore
      return updateState((previousState) => ({
        ...previousState,
        connectivity: connectedBefore ? "reconnecting" : "connecting",
        activity: "authenticating",
      })).pipe(
        Effect.andThen(
          Effect.result(
            Effect.scoped(
              Effect.gen(function* () {
                const physical = yield* makePhysicalConnection({
                  profile,
                  threadId: () => authority()?.threadId ?? input.threadId,
                  cursor: (threadId) =>
                    authority()?.threadId === threadId
                      ? authority()!.deliveredCursor
                      : (threadCursors.get(threadId) ?? "0"),
                  resolving: () => selection._tag === "Loading" && selection.authority === undefined,
                  opening: (connection) =>
                    Effect.sync(() => {
                      connecting = connection
                    }),
                  receive,
                  attached: commitInitialAttachment,
                  processed: (attachment, connection) =>
                    acknowledge(connection, String(attachment.threadId), String(attachment.cursor)),
                }).pipe(
                  Effect.provideService(Http, http),
                  Effect.provideService(CredentialStore, credentials),
                  Effect.provideService(ProfileStore, profiles),
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(Socket.WebSocketConstructor, webSocket),
                )
                publishConnection(physical)
                established = true
                yield* updateState((previousState) => ({
                  ...previousState,
                  connectivity: "connected",
                  ownership: profile.owner.kind === "personal" ? "personal" : "organization",
                }))
                return yield* physical.done
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    const threadId = authority()?.threadId
                    if (threadId !== undefined) resetPreviews(threadId)
                    publishConnection(undefined)
                  }),
                ),
              ),
            ),
          ),
        ),
        Effect.flatMap((result) =>
          stopped
            ? Effect.void
            : (result._tag === "Failure"
                ? updateState((previousState) => ({ ...previousState, connectivity: "reconnecting" })).pipe(
                    Effect.andThen(Effect.sleep("250 millis")),
                  )
                : Effect.void
              ).pipe(Effect.andThen(superviseConnection(established))),
        ),
      )
    })
  const connectionLoop = superviseConnection(false)

  const mutate = (
    operation: string,
    commandId: string,
    make: (threadId: ThreadId, version: string) => MutatingThreadCommand,
    completeOnAdmission = false,
    onSending: Effect.Effect<void> = Effect.void,
    onRejected: (outcome: Rejected) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const admitted = authority()
      if (admitted === undefined) return yield* failure("Hosted Thread authority is unavailable")
      const threadId = admitted.threadId
      const attempt = (retryStaleVersion: boolean): Effect.Effect<void, HostedError> =>
        Effect.suspend(() => {
          if (stopped) return Effect.fail(failure("Hosted interactive session is closed"))
          return Effect.gen(function* () {
            const projection = authority()
            if (projection === undefined || projection.threadId !== threadId)
              return yield* failure("Hosted Thread authority changed during command execution")
            const command = make(ThreadId.make(threadId), projection.version)
            const sendUntilKnown = (): Effect.Effect<CommandOutcome, HostedError> =>
              Effect.gen(function* () {
                const physical = yield* awaitConnection
                const requestId = `${commandId}:${yield* randomId}`
                const outcome = yield* Effect.result(
                  physical.command(requestId, command, completeOnAdmission, onSending, (rejected) =>
                    rejected.reason === "unavailable" ||
                    (retryStaleVersion &&
                      rejected.reason === "stale-version" &&
                      rejected.currentThreadVersion !== undefined)
                      ? Effect.void
                      : onRejected(rejected),
                  ),
                )
                if (outcome._tag === "Success") {
                  if (outcome.success._tag !== "CommandRejected" || outcome.success.reason !== "unavailable")
                    return outcome.success
                  yield* setActivity("unknown-operation")
                  yield* Effect.sleep("250 millis")
                  return yield* sendUntilKnown()
                }
                if (outcome.failure.kind === "protocol") return yield* outcome.failure
                if (current === physical) publishConnection(undefined)
                yield* updateState((previousState) => ({
                  ...previousState,
                  connectivity: "reconnecting",
                }))
                return yield* sendUntilKnown()
              })
            let outcome = yield* sendUntilKnown()
            while (outcome._tag === "CommandAdmitted") {
              const committed = authority()
              if (committed?.threadId === threadId && BigInt(outcome.threadVersion) > BigInt(committed.version))
                replaceAuthority(committed, { ...committed, version: String(outcome.threadVersion) })
              if (completeOnAdmission) return
              return yield* failure("Hosted Thread command completion was not pushed after durable admission")
            }
            if (outcome._tag === "CommandAccepted") {
              const committed = authority()
              if (committed?.threadId === threadId && BigInt(outcome.threadVersion) > BigInt(committed.version))
                replaceAuthority(committed, { ...committed, version: String(outcome.threadVersion) })
              return
            }
            if (retryStaleVersion && outcome.reason === "stale-version" && outcome.currentThreadVersion !== undefined) {
              const committed = authority()
              if (committed?.threadId !== threadId)
                return yield* failure("Hosted Thread authority changed during command retry")
              if (BigInt(outcome.currentThreadVersion) > BigInt(committed.version))
                replaceAuthority(committed, {
                  ...committed,
                  version: String(outcome.currentThreadVersion),
                })
              return yield* attempt(false)
            }
            if (outcome.reason === "conflict") yield* setActivity("unknown-operation")
            return yield* HostedError.make({
              kind: outcome.reason === "forbidden" ? "denied" : "protocol",
              message: outcome.message,
            })
          })
        })
      yield* attempt(true)
    }).pipe(Effect.mapError((error) => unavailable(operation, error)))

  const unsupported = (operation: string) =>
    Effect.fail(OperationUnavailable.make({ operation, message: `${operation} is unavailable for hosted Threads` }))
  const nextCommandId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => `${prefix}:${id}`),
      Effect.mapError((error) => unavailable(prefix, error)),
    )
  const session: InteractiveSession = {
    events: (next) =>
      Effect.suspend(() => {
        if (consumerAttached)
          return Effect.fail(
            OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: "Interactive session already has an event consumer",
            }),
          )
        consumerAttached = true
        dispatch = next
        return Effect.raceFirst(connectionLoop, Deferred.await(closed)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              consumerAttached = false
              dispatch = () => undefined
            }),
          ),
          Effect.mapError((error) => unavailable("InteractiveSession.events", error)),
        )
      }),
    currentView: () => authority()?.view,
    projectionCheckpoint: (turnId) =>
      [...(authority()?.authorizations.values() ?? [])].find((authorization) => String(authorization.turnId) === turnId)
        ?.checkpoint,
    submit: (prompt, mode, parts, _tuning, submissionId) =>
      Effect.gen(function* () {
        const selectedThreadId = authority()?.threadId
        if (selectedThreadId === undefined) return yield* unsupported("InteractiveSession.submit")
        const commandId = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const pendingCommandId =
              submissionId === undefined ? undefined : registerPendingSubmitCommandId(selectedThreadId, submissionId)
            if (submissionId !== undefined && pendingCommandId === undefined)
              return yield* OperationUnavailable.make({
                operation: "InteractiveSession.submit",
                message: "Hosted submission identity is already pending",
              })
            const allocatedCommandId = yield* nextCommandId("submit").pipe(
              Effect.tapError((error) =>
                pendingCommandId === undefined
                  ? Effect.void
                  : Deferred.fail(pendingCommandId.commandId, error).pipe(
                      Effect.andThen(forgetPendingSubmitCommandId(selectedThreadId, submissionId!)),
                      Effect.asVoid,
                    ),
              ),
            )
            if (pendingCommandId !== undefined) yield* Deferred.succeed(pendingCommandId.commandId, allocatedCommandId)
            return allocatedCommandId
          }),
        )
        const attachments = parts?.flatMap((part) => {
          if (part.type !== "image") return []
          const attachment: SubmitPromptAttachment =
            part.filename === undefined
              ? { mediaType: part.mediaType, data: part.data }
              : { mediaType: part.mediaType, data: part.data, filename: part.filename }
          return [attachment]
        })
        yield* mutate(
          "InteractiveSession.submit",
          commandId,
          (threadId, version) => {
            latestSubmitCommandIds.set(String(threadId), commandId)
            const command: SubmitPromptCommand = {
              _tag: "SubmitPrompt",
              threadId,
              commandId: CommandId.make(commandId),
              idempotencyKey: IdempotencyKey.make(commandId),
              expectedThreadVersion: ThreadVersion.make(version),
              text: prompt,
            }
            if (submissionId !== undefined) command.submissionId = submissionId
            if (mode !== undefined) command.mode = mode
            if (attachments !== undefined && attachments.length > 0) command.attachments = attachments
            return command
          },
          true,
          submissionId === undefined ? Effect.void : markPendingSubmissionSending(selectedThreadId, submissionId),
          () =>
            submissionId === undefined ? Effect.void : forgetPendingSubmitCommandId(selectedThreadId, submissionId),
        ).pipe(
          Effect.ensuring(
            submissionId === undefined ? Effect.void : forgetUnsentSubmission(selectedThreadId, submissionId),
          ),
        )
      }),
    shell: () => unsupported("InteractiveSession.shell"),
    editQueued: () => unsupported("InteractiveSession.editQueued"),
    dequeue: () => unsupported("InteractiveSession.dequeue"),
    steerQueued: (turnId, text, requestId) =>
      mutate("InteractiveSession.steerQueued", requestId, (threadId, version) => ({
        _tag: "Steer",
        threadId,
        commandId: CommandId.make(requestId),
        idempotencyKey: IdempotencyKey.make(requestId),
        expectedThreadVersion: ThreadVersion.make(version),
        text,
        targetTurnId: Turn.TurnId.make(turnId),
      })),
    steer: (text, requestId, turnId) => {
      const targetTurnId = turnId ?? activeTurnId()
      if (targetTurnId === undefined) return unsupported("InteractiveSession.steer")
      return mutate("InteractiveSession.steer", requestId, (threadId, version) => ({
        _tag: "Steer",
        threadId,
        commandId: CommandId.make(requestId),
        idempotencyKey: IdempotencyKey.make(requestId),
        expectedThreadVersion: ThreadVersion.make(version),
        text,
        targetTurnId: Turn.TurnId.make(String(targetTurnId)),
      }))
    },
    approveAuthorization: (turnId, authorizationId) => {
      const pending = authority()?.authorizations.get(`${turnId}:${authorizationId}`)
      if (pending === undefined) return unsupported("InteractiveSession.approveAuthorization")
      const commandId = `approve:${turnId}:${authorizationId}`
      return mutate("InteractiveSession.approveAuthorization", commandId, (threadId, version) => ({
        _tag: "Approve",
        threadId,
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
        turnId: pending.turnId,
        authorizationId,
        checkpoint: pending.checkpoint,
      }))
    },
    denyAuthorization: (turnId, authorizationId) => {
      const pending = authority()?.authorizations.get(`${turnId}:${authorizationId}`)
      if (pending === undefined) return unsupported("InteractiveSession.denyAuthorization")
      const commandId = `deny:${turnId}:${authorizationId}`
      return mutate("InteractiveSession.denyAuthorization", commandId, (threadId, version) => ({
        _tag: "Deny",
        threadId,
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
        turnId: pending.turnId,
        authorizationId,
        checkpoint: pending.checkpoint,
      }))
    },
    interruptAndSend: (prompt, requestedTargetTurnId) =>
      Effect.gen(function* () {
        const targetTurnId = requestedTargetTurnId ?? activeTurnId()
        if (targetTurnId === undefined) return yield* unsupported("InteractiveSession.interruptAndSend")
        const commandId = yield* nextCommandId("interrupt")
        yield* mutate("InteractiveSession.interruptAndSend", commandId, (threadId, version) => ({
          _tag: "InterruptAndSend",
          threadId,
          commandId: CommandId.make(commandId),
          idempotencyKey: IdempotencyKey.make(commandId),
          expectedThreadVersion: ThreadVersion.make(version),
          text: prompt,
          targetTurnId: Turn.TurnId.make(String(targetTurnId)),
        }))
      }),
    cancel: (requestedTarget = {}) =>
      Effect.gen(function* () {
        const selectedThreadId = requestedTarget.threadId ?? authority()?.threadId
        if (selectedThreadId === undefined) return yield* unsupported("InteractiveSession.cancel")
        if (authority()?.threadId !== selectedThreadId)
          return yield* unavailable(
            "InteractiveSession.cancel",
            failure("Hosted Thread authority changed before cancellation"),
          )
        const targetTurnId =
          requestedTarget.turnId ?? (requestedTarget.submissionId === undefined ? activeTurnId() : undefined)
        const latestSubmitCommandId = latestSubmitCommandIds.get(selectedThreadId)
        let target: CancellationTarget | undefined
        if (targetTurnId !== undefined) target = { _tag: "Turn", turnId: Turn.TurnId.make(String(targetTurnId)) }
        else {
          let targetCommandId = latestSubmitCommandId
          if (requestedTarget.submissionId !== undefined) {
            const pendingCommandId = pendingSubmitCommandIds.get(selectedThreadId)?.get(requestedTarget.submissionId)
            if (pendingCommandId === undefined) return yield* unsupported("InteractiveSession.cancel")
            targetCommandId = yield* Effect.raceFirst(
              Deferred.await(pendingCommandId.commandId),
              Deferred.await(closed).pipe(Effect.andThen(unsupported("InteractiveSession.cancel"))),
            )
          }
          if (targetCommandId !== undefined) target = { _tag: "Command", commandId: CommandId.make(targetCommandId) }
        }
        if (target === undefined) return yield* unsupported("InteractiveSession.cancel")
        const commandId = yield* nextCommandId("cancel")
        if (authority()?.threadId !== selectedThreadId)
          return yield* unavailable(
            "InteractiveSession.cancel",
            failure("Hosted Thread authority changed during cancellation"),
          )
        yield* mutate(
          "InteractiveSession.cancel",
          commandId,
          (threadId, version) => ({
            _tag: "Cancel",
            threadId,
            commandId: CommandId.make(commandId),
            idempotencyKey: IdempotencyKey.make(commandId),
            expectedThreadVersion: ThreadVersion.make(version),
            target,
          }),
          true,
        )
        if (requestedTarget.submissionId !== undefined)
          yield* forgetPendingSubmitCommandId(selectedThreadId, requestedTarget.submissionId)
      }),
    quit: Effect.suspend(() => {
      const physical = current
      stopped = true
      return (physical?.detach ?? Effect.void).pipe(
        Effect.ignore,
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            Deferred.doneUnsafe(closed, Effect.void)
          }),
        ),
      )
    }),
    newThread: Effect.gen(function* () {
      const threadId = yield* input.createThread("runner")
      yield* requestSelection(threadId)
    }).pipe(Effect.mapError((error) => unavailable("InteractiveSession.newThread", error))),
    newOrbThread: Effect.gen(function* () {
      const threadId = yield* input.createThread("orb")
      yield* requestSelection(threadId)
    }).pipe(Effect.mapError((error) => unavailable("InteractiveSession.newOrbThread", error))),
    archiveThread: unsupported("InteractiveSession.archiveThread"),
    archiveAndNewThread: unsupported("InteractiveSession.archiveAndNewThread"),
    selectThread: (threadId) =>
      requestSelection(threadId).pipe(
        Effect.mapError((error) => unavailable("InteractiveSession.selectThread", error)),
      ),
    readQueue: (threadId) =>
      Effect.suspend(() =>
        authority()?.threadId === threadId
          ? requestSelection(threadId)
          : Effect.fail(failure("Queue refresh requires the selected Thread")),
      ).pipe(Effect.mapError((error) => unavailable("InteractiveSession.readQueue", error))),
    previewThread: () => unsupported("InteractiveSession.previewThread"),
    reopenThread: Effect.suspend(() => requestSelection(authority()?.threadId ?? input.threadId)).pipe(
      Effect.mapError((error) => unavailable("InteractiveSession.reopenThread", error)),
    ),
  }
  return {
    session,
    connection: {
      initialState,
      stateChanges: SubscriptionRef.changes(state),
    },
  } satisfies HostedInteractiveSession
})
