import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  type ClientCommand,
  type ClientMessage,
  HostedThreadSnapshot,
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
import { OperationUnavailable } from "@rika/product/product-operation"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import * as ThreadView from "@rika/product/thread-view"
import { identityKey } from "@rika/transcript/transcript-unit-identity"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import type { Unit } from "@rika/transcript/transcript-unit"
import { CredentialStore, HostedError, Http, ProfileStore, type Profile } from "./hosted-contract"
import { authenticated, selectedProfile } from "./hosted-account"
import { connect } from "./hosted-thread-client"
import { Crypto, Deferred, Effect, Schema, Semaphore, SubscriptionRef } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

type Payload = ServerFrame["payload"]
type Accepted = Extract<Payload, { readonly _tag: "CommandAccepted" }>
type Rejected = Extract<Payload, { readonly _tag: "CommandRejected" }>
type Snapshot = Extract<Payload, { readonly _tag: "ThreadSnapshot" }>
const encodeHostedSnapshot = Schema.encodeSync(Schema.fromJsonString(HostedThreadSnapshot))
type CommandOutcome = Accepted | Rejected

const failure = (message: string) => HostedError.make({ kind: "network", message })
const unavailable = (operation: string, error: unknown) =>
  OperationUnavailable.make({
    operation,
    message: error instanceof Error ? error.message : String(error),
  })

const promptUnit = (turn: HostedThreadSnapshot["turns"][number]): Unit => {
  const key = identityKey("turn", turn.id, "user")
  return {
    key,
    turnId: String(turn.id),
    order: [{ sequence: -1, part: 0, key }],
    revision: 0,
    content: { _tag: "Entry", role: "user", text: turn.prompt },
  }
}

export const threadViewFromHostedSnapshot = (snapshot: HostedThreadSnapshot): ThreadView.ThreadViewSnapshot => {
  const grouped = new Map<string, Array<Unit>>()
  for (const unit of snapshot.units) {
    const units = grouped.get(unit.turnId) ?? []
    units.push(unit)
    grouped.set(unit.turnId, units)
  }
  const turns = snapshot.turns
    .filter((turn) => turn.status !== "queued")
    .map((turn) => {
      const units = grouped.get(String(turn.id)) ?? []
      return {
        turn: ThreadView.turnRecord(turn),
        units: (units.length === 0 ? [promptUnit(turn)] : units).toSorted((left, right) => {
          const order = compareUnitOrder(left.order, right.order)
          return order === 0 ? left.key.localeCompare(right.key) : order
        }),
        projectionRevision: 0,
        usage: ExecutionProjection.emptyUsageState(),
        pendingSteering: [],
        settledSteering: [],
      }
    })
    .toSorted((left, right) => left.turn.createdAt - right.turn.createdAt)
  return {
    thread: snapshot.thread,
    revision: 0,
    source: { projectionVersion: ExecutionProjection.projectionVersion },
    turns,
    pending: snapshot.queue.turns.slice(0, ThreadView.limits.pending).map((turn) => ({
      id: turn.id,
      prompt: turn.prompt,
      createdAt: turn.createdAt,
    })),
    hasOlder: false,
    hasNewer: false,
    usage: { state: ExecutionProjection.aggregateUsage(turns.map((turn) => turn.usage)) },
  }
}

const envelope = (requestId: string, command: ClientCommand): ClientMessage => ({
  protocolVersion,
  requestId: RequestId.make(requestId),
  command,
})

interface PhysicalConnection {
  readonly command: (requestId: string, command: ClientCommand) => Effect.Effect<CommandOutcome, HostedError>
  readonly attach: (threadId: string, cursor: string) => Effect.Effect<Snapshot, HostedError>
  readonly detach: Effect.Effect<void, HostedError>
  readonly done: Effect.Effect<never, HostedError>
}

const makePhysicalConnection = Effect.fn("HostedInteractiveSession.physical")(function* (input: {
  readonly profile: Profile
  readonly threadId: () => string
  readonly cursor: (threadId: string) => string
  readonly receive: (payload: Payload, connection: PhysicalConnection) => Effect.Effect<void, HostedError>
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
  const outcomes = new Map<string, Deferred.Deferred<CommandOutcome, HostedError>>()
  const snapshots = new Map<string, Deferred.Deferred<Snapshot, HostedError>>()
  const disconnected = yield* Deferred.make<never, HostedError>()
  const failPending = (error: HostedError) =>
    Effect.sync(() => {
      for (const waiter of outcomes.values()) Deferred.doneUnsafe(waiter, Effect.fail(error))
      for (const waiter of snapshots.values()) Deferred.doneUnsafe(waiter, Effect.fail(error))
      outcomes.clear()
      snapshots.clear()
      Deferred.doneUnsafe(disconnected, Effect.fail(error))
    })
  let physical: PhysicalConnection
  const command = (requestId: string, value: ClientCommand) =>
    Effect.gen(function* () {
      const waiter = yield* Deferred.make<CommandOutcome, HostedError>()
      outcomes.set(requestId, waiter)
      yield* socket
        .send(envelope(requestId, value))
        .pipe(Effect.onError(() => Effect.sync(() => outcomes.delete(requestId))))
      return yield* Deferred.await(waiter).pipe(Effect.ensuring(Effect.sync(() => outcomes.delete(requestId))))
    })
  const attach = (threadId: string, cursor: string) =>
    Effect.gen(function* () {
      const requestId = `attach:${threadId}:${yield* randomId}`
      const waiter = yield* Deferred.make<Snapshot, HostedError>()
      snapshots.set(requestId, waiter)
      yield* socket
        .send(
          envelope(requestId, {
            _tag: "AttachThread",
            threadId: ThreadId.make(threadId),
            afterCursor: ThreadEventCursor.make(cursor),
          }),
        )
        .pipe(Effect.onError(() => Effect.sync(() => snapshots.delete(requestId))))
      return yield* Deferred.await(waiter).pipe(Effect.ensuring(Effect.sync(() => snapshots.delete(requestId))))
    })
  physical = {
    command,
    attach,
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
      if (payload._tag === "ThreadSnapshot" && payload.requestId !== undefined) {
        const waiter = snapshots.get(payload.requestId)
        if (waiter !== undefined) yield* Deferred.succeed(waiter, payload)
      } else if (payload._tag === "CommandAccepted" || payload._tag === "CommandRejected") {
        const waiter = outcomes.get(payload.requestId)
        if (waiter !== undefined) yield* Deferred.succeed(waiter, payload)
        if (payload._tag === "CommandRejected") {
          const snapshotWaiter = snapshots.get(payload.requestId)
          if (snapshotWaiter !== undefined)
            yield* Deferred.fail(snapshotWaiter, HostedError.make({ kind: "protocol", message: payload.message }))
        }
      }
    }
  }).pipe(
    Effect.catch((error) => failPending(error)),
    Effect.ensuring(failPending(failure("Hosted Thread connection closed"))),
    Effect.forkScoped,
  )
  yield* physical.attach(input.threadId(), input.cursor(input.threadId()))
  return physical
})

export interface HostedInteractiveSession {
  readonly session: InteractiveSession
  readonly connection: InteractiveConnection.Connection
}

export const makeHostedInteractiveSession = Effect.fn("HostedInteractiveSession.make")(function* (input: {
  readonly threadId: string
  readonly executorKind: "runner" | "orb"
  readonly createThread: (executorKind: "runner" | "orb") => Effect.Effect<string, HostedError>
  readonly setRemoteThreadCreation: (preference: "allowed" | "denied") => Effect.Effect<void, HostedError>
}) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const credentials = yield* CredentialStore
  const profiles = yield* ProfileStore
  const crypto = yield* Crypto.Crypto
  const webSocket = yield* Socket.WebSocketConstructor
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("Hosted Thread request identifier could not be created")),
  )
  const commandAdmission = yield* Semaphore.make(1)
  const status = yield* SubscriptionRef.make<InteractiveConnection.Status>("connecting")
  const closed = yield* Deferred.make<void>()
  const versions = new Map<string, string>()
  const cursors = new Map<string, string>()
  const rendered = new Map<string, string>()
  const authorizations = new Map<string, HostedThreadSnapshot["pendingAuthorizations"][number]>()
  let latestHostedStatus: InteractiveConnection.Status = "connected"
  let selected = input.threadId
  let dispatch: (event: InteractiveEvent) => void = () => undefined
  let consumerAttached = false
  let stopped = false
  let current: PhysicalConnection | undefined
  let connectionChanged = Deferred.makeUnsafe<void>()
  const setHostedStatus = (value: InteractiveConnection.Status) => {
    latestHostedStatus = value
    return SubscriptionRef.set(status, value)
  }

  const publishConnection = (value: PhysicalConnection | undefined) => {
    current = value
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
      yield* Effect.forkChild(
        connection
          .command(requestId, {
            _tag: "AcknowledgeCursor",
            cursor: ThreadEventCursor.make(cursor),
          })
          .pipe(Effect.ignore),
      )
    })
  const statusState = (payload: Extract<Payload, { readonly _tag: "ExecutorStatus" | "WorkspaceStatus" }>) => {
    const state = payload.status.state
    if (typeof state !== "string") return undefined
    const states: Record<string, InteractiveConnection.Status> = {
      waiting: "executor-waiting",
      connecting: "executor-connecting",
      connected: "executor-connected",
      preparing: "workspace-preparing",
      setup: "workspace-setup",
      resuming: "workspace-resuming",
      leased: "lease-active",
      retrying: "retrying",
      approval: "approval-required",
      unknown: "unknown-operation",
      terminal: "terminal",
    }
    return states[state]
  }
  const receive = (payload: Payload, connection: PhysicalConnection) =>
    Effect.gen(function* () {
      if (payload._tag === "ExecutorStatus" || payload._tag === "WorkspaceStatus") {
        const next = statusState(payload)
        if (next !== undefined) yield* setHostedStatus(next)
        return
      }
      if (payload._tag === "PresenceSnapshot") {
        if (payload.participants.length > 1) yield* setHostedStatus("presence")
        return
      }
      if (payload._tag === "CommandAccepted") {
        versions.set(String(payload.threadId), String(payload.threadVersion))
        return
      }
      if (payload._tag === "CommandRejected") {
        if (payload.threadId !== undefined && payload.currentThreadVersion !== undefined)
          versions.set(String(payload.threadId), String(payload.currentThreadVersion))
        return
      }
      if (payload._tag === "ThreadSnapshot") {
        const threadId = String(payload.threadId)
        versions.set(threadId, String(payload.threadVersion))
        cursors.set(threadId, String(payload.cursor))
        authorizations.clear()
        for (const pending of payload.snapshot.pendingAuthorizations)
          authorizations.set(`${pending.turnId}:${pending.authorizationId}`, pending)
        const renderVersion = `${payload.threadVersion}:${payload.cursor}:${encodeHostedSnapshot(payload.snapshot)}`
        if (rendered.get(threadId) !== renderVersion) {
          rendered.set(threadId, renderVersion)
          dispatch({ _tag: "ThreadViewSnapshot", snapshot: threadViewFromHostedSnapshot(payload.snapshot) })
        }
        const active = payload.snapshot.turns.filter((turn) => turn.status !== "queued")
        if (payload.snapshot.pendingAuthorizations.length > 0) yield* setHostedStatus("approval-required")
        else if (active.some((turn) => turn.status === "waiting")) yield* setHostedStatus("executor-waiting")
        else if (
          active.length > 0 &&
          active.every((turn) => turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled")
        )
          yield* setHostedStatus("terminal")
        else if (active.some((turn) => turn.status === "running" || turn.status === "cancelling"))
          yield* setHostedStatus("executor-connected")
        else if (active.length > 0) yield* setHostedStatus("workspace-preparing")
        else if (input.executorKind === "runner") yield* setHostedStatus("executor-waiting")
        else yield* setHostedStatus("connected")
        yield* acknowledge(connection, threadId, String(payload.cursor))
        return
      }
      if (payload._tag === "ThreadEvent") {
        const threadId = String(payload.event.threadId)
        const next = BigInt(payload.event.cursor)
        const previous = BigInt(cursors.get(threadId) ?? "0")
        if (next <= previous) return
        versions.set(threadId, String(payload.event.threadVersion))
        cursors.set(threadId, String(payload.event.cursor))
        rendered.set(threadId, `${payload.event.threadVersion}:${payload.event.cursor}`)
        dispatch(payload.event.event)
        yield* acknowledge(connection, threadId, String(payload.event.cursor))
      }
    })

  const superviseConnection = (connectedBefore: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (stopped) return Effect.void
      let established = connectedBefore
      return SubscriptionRef.set(status, connectedBefore ? "reconnecting" : "connecting").pipe(
        Effect.andThen(SubscriptionRef.set(status, "authenticating")),
        Effect.andThen(
          Effect.result(
            Effect.scoped(
              Effect.gen(function* () {
                const physical = yield* makePhysicalConnection({
                  profile,
                  threadId: () => selected,
                  cursor: (threadId) => cursors.get(threadId) ?? "0",
                  receive,
                }).pipe(
                  Effect.provideService(Http, http),
                  Effect.provideService(CredentialStore, credentials),
                  Effect.provideService(ProfileStore, profiles),
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(Socket.WebSocketConstructor, webSocket),
                )
                publishConnection(physical)
                established = true
                yield* SubscriptionRef.set(
                  status,
                  profile.owner.kind === "personal" ? "personal-owner" : "organization-owner",
                )
                yield* SubscriptionRef.set(
                  status,
                  input.executorKind === "runner" ? "local-placement" : "e2b-placement",
                )
                yield* SubscriptionRef.set(status, latestHostedStatus)
                const replay = Effect.sleep("500 millis").pipe(
                  Effect.andThen(physical.attach(selected, cursors.get(selected) ?? "0")),
                  Effect.forever,
                )
                return yield* Effect.raceFirst(physical.done, replay)
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
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
            : (result._tag === "Failure" ? Effect.sleep("250 millis") : Effect.void).pipe(
                Effect.andThen(superviseConnection(established)),
              ),
        ),
      )
    })
  const connectionLoop = superviseConnection(false)

  const mutate = (
    operation: string,
    commandId: string,
    make: (version: string) => Exclude<ClientCommand, { readonly _tag: "AttachThread" }>,
  ) =>
    commandAdmission
      .withPermits(1)(
        Effect.gen(function* () {
          const threadId = selected
          const attempt = (): Effect.Effect<void, HostedError> =>
            Effect.suspend(() => {
              if (stopped) return Effect.fail(failure("Hosted interactive session is closed"))
              return Effect.gen(function* () {
                const physical = yield* awaitConnection
                const requestId = `${commandId}:${yield* randomId}`
                const outcome = yield* Effect.result(physical.command(requestId, make(versions.get(threadId) ?? "0")))
                if (outcome._tag === "Failure") {
                  if (current === physical) publishConnection(undefined)
                  yield* setHostedStatus("retrying")
                  return yield* attempt()
                }
                if (outcome.success._tag === "CommandAccepted") return
                if (outcome.success.reason === "stale-version" && outcome.success.currentThreadVersion !== undefined) {
                  versions.set(threadId, String(outcome.success.currentThreadVersion))
                  return yield* attempt()
                }
                if (outcome.success.reason === "conflict" || outcome.success.reason === "unavailable")
                  yield* setHostedStatus("unknown-operation")
                return yield* HostedError.make({
                  kind: outcome.success.reason === "forbidden" ? "denied" : "protocol",
                  message: outcome.success.message,
                })
              })
            })
          yield* attempt()
        }),
      )
      .pipe(Effect.mapError((error) => unavailable(operation, error)))

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
    submit: (prompt, mode, parts, _tuning, submissionId) =>
      Effect.gen(function* () {
        const commandId = submissionId ?? (yield* nextCommandId("submit"))
        yield* mutate("InteractiveSession.submit", commandId, (version) => ({
          _tag: "SubmitPrompt",
          commandId: CommandId.make(commandId),
          idempotencyKey: IdempotencyKey.make(commandId),
          expectedThreadVersion: ThreadVersion.make(version),
          text: prompt,
          ...(mode === undefined ? {} : { mode }),
          ...(parts === undefined
            ? {}
            : {
                attachments: parts.flatMap((part) =>
                  part.type === "image"
                    ? [
                        {
                          mediaType: part.mediaType,
                          data: part.data,
                          ...(part.filename === undefined ? {} : { filename: part.filename }),
                        },
                      ]
                    : [],
                ),
              }),
        }))
      }),
    shell: () => unsupported("InteractiveSession.shell"),
    editQueued: () => unsupported("InteractiveSession.editQueued"),
    dequeue: () => unsupported("InteractiveSession.dequeue"),
    steerQueued: (turnId, text, requestId) =>
      mutate("InteractiveSession.steerQueued", requestId, (version) => ({
        _tag: "Steer",
        commandId: CommandId.make(requestId),
        idempotencyKey: IdempotencyKey.make(requestId),
        expectedThreadVersion: ThreadVersion.make(version),
        text,
        targetTurnId: turnId as never,
      })),
    steer: (text, requestId, turnId) =>
      mutate("InteractiveSession.steer", requestId, (version) => ({
        _tag: "Steer",
        commandId: CommandId.make(requestId),
        idempotencyKey: IdempotencyKey.make(requestId),
        expectedThreadVersion: ThreadVersion.make(version),
        text,
        ...(turnId === undefined ? {} : { targetTurnId: turnId as never }),
      })),
    approveAuthorization: (turnId, authorizationId) => {
      const pending = authorizations.get(`${turnId}:${authorizationId}`)
      if (pending === undefined) return unsupported("InteractiveSession.approveAuthorization")
      const commandId = `approve:${turnId}:${authorizationId}`
      return mutate("InteractiveSession.approveAuthorization", commandId, (version) => ({
        _tag: "Approve",
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
        turnId: pending.turnId,
        authorizationId,
        checkpoint: pending.checkpoint,
      }))
    },
    denyAuthorization: (turnId, authorizationId) => {
      const pending = authorizations.get(`${turnId}:${authorizationId}`)
      if (pending === undefined) return unsupported("InteractiveSession.denyAuthorization")
      const commandId = `deny:${turnId}:${authorizationId}`
      return mutate("InteractiveSession.denyAuthorization", commandId, (version) => ({
        _tag: "Deny",
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
        turnId: pending.turnId,
        authorizationId,
        checkpoint: pending.checkpoint,
      }))
    },
    interruptAndSend: (prompt) =>
      Effect.gen(function* () {
        const commandId = yield* nextCommandId("interrupt")
        yield* mutate("InteractiveSession.interruptAndSend", commandId, (version) => ({
          _tag: "InterruptAndSend",
          commandId: CommandId.make(commandId),
          idempotencyKey: IdempotencyKey.make(commandId),
          expectedThreadVersion: ThreadVersion.make(version),
          text: prompt,
        }))
      }),
    cancel: Effect.gen(function* () {
      const commandId = yield* nextCommandId("cancel")
      yield* mutate("InteractiveSession.cancel", commandId, (version) => ({
        _tag: "Cancel",
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
      }))
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
      selected = threadId
      cursors.set(threadId, "0")
      versions.set(threadId, "0")
      const physical = yield* awaitConnection
      yield* physical.attach(threadId, "0")
    }).pipe(Effect.mapError((error) => unavailable("InteractiveSession.newThread", error))),
    newOrbThread: Effect.gen(function* () {
      const threadId = yield* input.createThread("orb")
      selected = threadId
      cursors.set(threadId, "0")
      versions.set(threadId, "0")
      const physical = yield* awaitConnection
      yield* physical.attach(threadId, "0")
    }).pipe(Effect.mapError((error) => unavailable("InteractiveSession.newOrbThread", error))),
    pauseOrb: Effect.gen(function* () {
      const commandId = yield* nextCommandId("pause-orb")
      yield* mutate("InteractiveSession.pauseOrb", commandId, (version) => ({
        _tag: "PauseOrb",
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
      }))
    }),
    resumeOrb: Effect.gen(function* () {
      const commandId = yield* nextCommandId("resume-orb")
      yield* mutate("InteractiveSession.resumeOrb", commandId, (version) => ({
        _tag: "ResumeOrb",
        commandId: CommandId.make(commandId),
        idempotencyKey: IdempotencyKey.make(commandId),
        expectedThreadVersion: ThreadVersion.make(version),
      }))
    }),
    enableRemoteThreadCreation: input
      .setRemoteThreadCreation("allowed")
      .pipe(Effect.mapError((error) => unavailable("InteractiveSession.enableRemoteThreadCreation", error))),
    disableRemoteThreadCreation: input
      .setRemoteThreadCreation("denied")
      .pipe(Effect.mapError((error) => unavailable("InteractiveSession.disableRemoteThreadCreation", error))),
    archiveThread: unsupported("InteractiveSession.archiveThread"),
    archiveAndNewThread: unsupported("InteractiveSession.archiveAndNewThread"),
    selectThread: (threadId) =>
      threadId === selected
        ? Effect.void
        : commandAdmission
            .withPermits(1)(
              Effect.gen(function* () {
                selected = threadId
                const physical = yield* awaitConnection
                yield* physical.attach(threadId, cursors.get(threadId) ?? "0")
              }),
            )
            .pipe(Effect.mapError((error) => unavailable("InteractiveSession.selectThread", error))),
    readQueue: (threadId) =>
      commandAdmission
        .withPermits(1)(
          Effect.gen(function* () {
            const physical = yield* awaitConnection
            yield* physical.attach(threadId, cursors.get(threadId) ?? "0")
          }),
        )
        .pipe(Effect.mapError((error) => unavailable("InteractiveSession.readQueue", error))),
    previewThread: () => unsupported("InteractiveSession.previewThread"),
    reopenThread: commandAdmission
      .withPermits(1)(
        Effect.gen(function* () {
          const physical = yield* awaitConnection
          yield* physical.attach(selected, cursors.get(selected) ?? "0")
        }),
      )
      .pipe(Effect.mapError((error) => unavailable("InteractiveSession.reopenThread", error))),
  }
  return {
    session,
    connection: {
      initialStatus: "connecting",
      statusChanges: SubscriptionRef.changes(status),
    },
  } satisfies HostedInteractiveSession
})
