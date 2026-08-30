import { hostedThreadSnapshotMatches } from "@rika/product/client-protocol"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import * as HostedObservability from "@rika/product/hosted-observability"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import type { ThreadSummary } from "@rika/product/thread-summary"
import type { Unit } from "@rika/transcript/transcript-unit"
import { CredentialStore, HostedError, Http, ProfileStore, type Profile } from "./contract"
import { reconnectDelay, retryableConnectionFailure } from "./reconnect-policy"
import {
  physicalConnection as openPhysicalConnection,
  type PendingAttachment,
  type PhysicalConnection,
} from "./interactive-session/connection"
import { interactiveSessionCommands } from "./interactive-session/commands"
import { interactivePreviewState, interactiveSessionEvents } from "./interactive-session/events"
import { interactiveSessionInterface } from "./interactive-session/interface"
import { InteractiveSessionState } from "./interactive-session/state"
import { interactiveSessionStatus } from "./interactive-session/status"
import {
  AttachmentProjection,
  type Attachment,
  type PreparedAttachment,
  type Projection,
  type SelectionState,
  type Snapshot,
} from "./interactive-session/projection"
import { Crypto, Deferred, Effect, Exit, Schema, Semaphore, SubscriptionRef } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

const { encodeThreadView, failure, prepareAttachment, threadViewFromHostedSnapshot, unavailable } = AttachmentProjection
export { threadViewFromHostedSnapshot }

export interface HostedInteractiveSession {
  readonly session: InteractiveSession
  readonly connection: InteractiveConnection.Connection
}

export const makeHostedInteractiveSession = Effect.fn("HostedInteractiveSession.make")(function* (input: {
  readonly profile: Profile
  readonly threadId: string
  readonly createThread: (
    executorKind: "runner" | "orb",
    archiveThreadId?: string,
  ) => Effect.Effect<string, HostedError>
  readonly listThreads: Effect.Effect<ReadonlyArray<ThreadSummary>, HostedError>
  readonly previewThread: (threadId: string) => Effect.Effect<ReadonlyArray<Unit>, HostedError>
}) {
  const profile = input.profile
  const http = yield* Http
  const credentials = yield* CredentialStore
  const profiles = yield* ProfileStore
  const crypto = yield* Crypto.Crypto
  const webSocket = yield* Socket.WebSocketConstructor
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("Thread request identifier could not be created")),
  )
  const selectionAdmission = yield* Semaphore.make(1)
  const { initialState, state, update, setActivity, setParticipants, publishProjection } =
    yield* interactiveSessionStatus
  const closed = yield* Deferred.make<void>()
  let selection: SelectionState = { _tag: "Loading", token: {}, threadId: input.threadId, authority: undefined }
  let dispatch: (event: InteractiveEvent) => void = () => undefined
  let consumerAttached = false
  let stopped = false
  let current: PhysicalConnection | undefined
  let connecting: PhysicalConnection | undefined
  const threadCursors = new Map<string, string>()
  const { activePreviews, resetPreviews } = interactivePreviewState((event) => dispatch(event))
  let connectionChanged = Deferred.makeUnsafe<void>()
  const refreshThreads = input.listThreads.pipe(
    Effect.tap((threads) => Effect.sync(() => dispatch({ _tag: "ThreadsListed", threads }))),
    Effect.catch((error) =>
      Effect.logWarning("thread-list.refresh.failed").pipe(Effect.annotateLogs("message", error.message)),
    ),
  )

  const publishConnection = (value: PhysicalConnection | undefined) => {
    current = value
    connecting = undefined
    Deferred.doneUnsafe(connectionChanged, Effect.void)
    connectionChanged = Deferred.makeUnsafe<void>()
  }
  const awaitConnection: Effect.Effect<PhysicalConnection, HostedError> = Effect.suspend(() => {
    if (stopped) return Effect.fail(failure("Interactive session is closed"))
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
  const commitSnapshot = (payload: Snapshot, connection: PhysicalConnection) =>
    Effect.gen(function* () {
      const threadId = String(payload.threadId)
      if (!selectedFrame(threadId)) return
      if (!hostedThreadSnapshotMatches(payload.snapshot, threadId))
        return yield* failure("Thread snapshot identity did not match its response")
      const previous = authority()!
      const cursor = BigInt(payload.cursor)
      const previousCursor = BigInt(previous.committedCursor)
      if (cursor < previousCursor) return
      if (BigInt(payload.threadVersion) < BigInt(previous.representedVersion))
        return yield* failure("Thread snapshot version regressed")
      const projected = InteractiveSessionState.projectionFromSnapshot(
        payload,
        previous.participants,
        previous.deliveredCursor,
        previous.deliveredFingerprint,
        failure,
      )
      if (Schema.is(HostedError)(projected)) return yield* projected
      const candidate =
        BigInt(projected.version) < BigInt(previous.version) ? { ...projected, version: previous.version } : projected
      const fingerprint = encodeThreadView(payload.snapshot.view)
      if (!replaceAuthority(previous, candidate)) return
      yield* publishProjection(candidate)
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
  const planAttachment = (prepared: PreparedAttachment, previous: Projection | undefined) =>
    InteractiveSessionState.planAttachment(prepared, previous, threadCursors, failure)
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
      const validation = prepareAttachment(attachment, authority())
      if (validation._tag === "Invalid") return yield* validation.error
      const threadId = String(validation.prepared.attachment.threadId)
      const plan = planAttachment(validation.prepared, authority())
      if (plan._tag === "Invalid") return yield* plan.error
      yield* commands.reconcilePendingSubmissions(validation.prepared)
      const bootstrap = selection._tag === "Loading" && selection.authority === undefined
      selection =
        selection._tag === "Loading" && !bootstrap
          ? { ...selection, authority: plan.candidate }
          : { _tag: "Attached", projection: plan.candidate }
      yield* publishProjection(plan.candidate)
      const fingerprint = yield* publishAttachment(validation.prepared, plan)
      const delivered = {
        ...plan.candidate,
        deliveredCursor: plan.candidate.committedCursor,
        deliveredFingerprint: fingerprint,
      }
      replaceAuthority(plan.candidate, delivered)
      threadCursors.set(threadId, delivered.deliveredCursor)
      yield* refreshThreads
    })
  const receive = interactiveSessionEvents({
    activePreviews,
    currentFrame,
    selectedFrame,
    resetPreviews,
    dispatch: (event) => dispatch(event),
    authority,
    replaceAuthority,
    setParticipants,
    commitSnapshot,
    reconcileSubmission: (threadId, submissionId) => commands.reconcileSubmission(threadId, submissionId),
    acknowledge,
    threadCursors,
    failure,
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
              yield* update(({ activity: _, ...previousState }) => ({
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
                    previous?.threadId === threadId ? previous.deliveredCursor : "0",
                    previous?.threadId === threadId ? previous.checkpointCursor : undefined,
                  ),
                ),
              ),
            ).pipe(Effect.exit)
            if (outcome._tag === "Success") pending = outcome.value
            let preparedCandidate: Projection | undefined
            const currentAuthority =
              selection._tag === "Loading" && selection.token === request.token ? selection.authority : undefined
            const validation =
              outcome._tag === "Success" ? prepareAttachment(outcome.value.attachment, currentAuthority) : undefined
            const plan =
              validation?._tag === "Valid" ? planAttachment(validation.prepared, currentAuthority) : undefined
            const selectionError = () => {
              if (validation?._tag === "Invalid") return validation.error
              if (plan?._tag === "Invalid") return plan.error
              const currentSelection = selection
              const superseded =
                outcome._tag === "Success" &&
                (physical === undefined ||
                  current !== physical ||
                  currentSelection._tag !== "Loading" ||
                  currentSelection.token !== request.token ||
                  currentSelection.threadId !== threadId)
              return superseded ? failure("Thread selection was superseded") : undefined
            }
            const failInvalidOutcome = (invalid: HostedError) =>
              (pending === undefined ? Effect.void : pending.fail(invalid)).pipe(
                Effect.andThen(outcome._tag === "Failure" ? Effect.failCause(outcome.cause) : invalid),
              )
            const committedSelection = (candidate: Projection) =>
              selection._tag === "Loading" && selection.token === request.token && selection.authority === candidate
            const attachmentAdvanced = (candidate: Projection) =>
              previous?.threadId !== threadId || previous.deliveredCursor !== candidate.committedCursor
            yield* Effect.gen(function* () {
              const invalid = selectionError()
              if (outcome._tag === "Failure" || invalid !== undefined)
                return yield* failInvalidOutcome(invalid ?? failure("Thread selection attachment was invalid"))
              if (validation?._tag !== "Valid" || plan?._tag !== "Valid")
                return yield* failure("Thread selection attachment was not valid")
              const prepared = validation.prepared
              const committedPlan = plan
              yield* commands.reconcilePendingSubmissions(prepared)
              preparedCandidate = committedPlan.candidate
              if (currentAuthority === undefined || !replaceAuthority(currentAuthority, preparedCandidate))
                return yield* failure("Thread selection was superseded")
              yield* publishProjection(committedPlan.candidate)
              const fingerprint = yield* publishAttachment(prepared, committedPlan)
              const delivered = {
                ...committedPlan.candidate,
                deliveredCursor: committedPlan.candidate.committedCursor,
                deliveredFingerprint: fingerprint,
              }
              if (!committedSelection(committedPlan.candidate)) return yield* failure("Thread selection was superseded")
              selection = { _tag: "Attached", projection: delivered }
              threadCursors.set(threadId, delivered.deliveredCursor)
              if (attachmentAdvanced(committedPlan.candidate))
                yield* acknowledge(physical!, threadId, committedPlan.candidate.committedCursor)
              yield* pending!.complete
            }).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) return Effect.void
                return Effect.gen(function* () {
                  if (pending !== undefined)
                    yield* pending.fail(failure("Thread attachment processing did not complete"))
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
            return publishProjection(previous)
          }),
        )
      }),
    )

  const superviseConnection = (connectedBefore: boolean, failedAttempts: number): Effect.Effect<void, HostedError> =>
    Effect.suspend(() => {
      if (stopped) return Effect.void
      let attached = false
      return update((previousState) => ({
        ...previousState,
        connectivity: connectedBefore ? "reconnecting" : "connecting",
        activity: "authenticating",
      })).pipe(
        Effect.andThen(
          Effect.scoped(
            Effect.gen(function* () {
              const physical = yield* openPhysicalConnection({
                profile,
                threadId: () => authority()?.threadId ?? input.threadId,
                cursor: (threadId) => (authority()?.threadId === threadId ? authority()!.deliveredCursor : "0"),
                checkpointCursor: (threadId) =>
                  authority()?.threadId === threadId ? authority()!.checkpointCursor : undefined,
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
              attached = true
              yield* update((previousState) => ({
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
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) => {
                if (stopped) return Effect.void
                if (!retryableConnectionFailure(error))
                  return update((previousState) => ({
                    ...previousState,
                    connectivity: "disconnected",
                  })).pipe(Effect.andThen(Effect.fail(error)))
                const attempt = attached ? 0 : failedAttempts
                const delay = reconnectDelay(
                  error.retryAfterMillis === undefined
                    ? { attempt }
                    : { attempt, retryAfterMillis: error.retryAfterMillis },
                )
                const reconnect = {
                  "rika.failure.category": error.kind === "rate-limit" ? "rate_limited" : "dependency_unavailable",
                  "rika.reconnect.attempt": attempt + 1,
                  "rika.reconnect.delay.ms": delay,
                }
                const status =
                  error.status === undefined ? reconnect : { ...reconnect, "rika.http.status": error.status }
                const annotations =
                  error.retryAfterMillis === undefined
                    ? status
                    : { ...status, "rika.retry_after.ms": error.retryAfterMillis }
                return update((previousState) => ({ ...previousState, connectivity: "reconnecting" })).pipe(
                  Effect.andThen(
                    Effect.logInfo("connection.reconnect.scheduled").pipe(Effect.annotateLogs(annotations)),
                  ),
                  Effect.andThen(Effect.sleep(delay)),
                  Effect.andThen(superviseConnection(connectedBefore || attached, attempt + 1)),
                )
              },
              onSuccess: () => Effect.void,
            }),
          ),
        ),
      )
    })
  const connectionLoop = superviseConnection(false, 0)

  const nextCommandId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => `${prefix}:${id}`),
      Effect.mapError((error) => unavailable(prefix, error)),
    )
  const commands = interactiveSessionCommands({
    authority,
    replaceAuthority,
    awaitConnection,
    connectionLost: (physical) => {
      if (current === physical) publishConnection(undefined)
      return update((previousState) => ({ ...previousState, connectivity: "reconnecting" }))
    },
    randomId,
    nextCommandId,
    setUnknownActivity: setActivity("unknown-operation"),
    refreshThreads,
    closed,
    stopped: () => stopped,
    failure,
    unavailable,
  })
  const quit = Effect.suspend(() => {
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
  })
  const session = interactiveSessionInterface({
    commands,
    authority,
    connectionLoop,
    closed,
    consumerAttached: () => consumerAttached,
    attachConsumer: (next) => {
      consumerAttached = true
      dispatch = next
    },
    detachConsumer: () => {
      consumerAttached = false
      dispatch = () => undefined
    },
    unavailable,
    quit,
    createThread: input.createThread,
    requestSelection,
    initialThreadId: input.threadId,
    previewThread: input.previewThread,
    dispatch: (event) => dispatch(event),
    failure,
  })
  return {
    session,
    connection: {
      initialState,
      stateChanges: SubscriptionRef.changes(state),
    },
  } satisfies HostedInteractiveSession
})
