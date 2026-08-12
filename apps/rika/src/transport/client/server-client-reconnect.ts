import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as ServerFeed from "@rika/product/server-interactive-feed"
import * as ServerService from "@rika/product/server-service"
import * as Thread from "@rika/product/thread-record"
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Function, Ref, Schedule, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { failureKind, transportError } from "../protocol/server-message-codec"

const mapServerSocketFailure = (cause: unknown, accepted: boolean): ServerService.ServerServiceError => {
  if (Socket.SocketError.is(cause) && cause.reason._tag === "SocketCloseError") {
    if (cause.reason.code === 4409 || cause.reason.code === 1001)
      return transportError("Rika Server is draining", "server-draining")
    if (cause.reason.code === 4406)
      return transportError(
        cause.reason.closeReason ||
          "A listener reported an unsigned server incompatibility; stop it, then run rika again",
        "foreign-listener",
      )
    if (cause.reason.code === 4401)
      return transportError(
        cause.reason.closeReason ??
          "A Rika server with different credentials is still running; close other Rika clients, then run rika again",
        "foreign-listener",
      )
  }
  return transportError(String(cause), accepted ? "transport-failed" : "server-absent")
}

export const serverSocketFailure: {
  (accepted: boolean): (cause: unknown) => ServerService.ServerServiceError
  (cause: unknown, accepted: boolean): ServerService.ServerServiceError
} = Function.dual(2, mapServerSocketFailure)

export const reconnectFailureLimit = 8
export const reconnectStableMilliseconds = 30_000
export const reconnectSchedule = Schedule.exponential("25 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(1)))),
)

export const isDisconnectedOperation = (error: unknown) =>
  Schema.is(ProductOperation.OperationUnavailable)(error) && error.operation === "ServerConnection"

export const isReconnectableTransport = (error: unknown) =>
  Schema.is(ServerService.ServerServiceError)(error) &&
  (error.reason === "server-absent" || error.reason === "server-draining" || error.reason === "transport-failed")

const ignoreInteractiveEvent = (_event: InteractiveEvent.InteractiveEvent) => {}

type SupervisorContext = {
  readonly initial: ServerService.Connection
  readonly acquireReady: (
    policy: "launch" | "reattach",
  ) => Effect.Effect<
    ServerService.Connection,
    ServerService.ServerServiceError | ServerService.ServerRestartRequired,
    never
  >
  readonly logicalClosed: Deferred.Deferred<void>
}

export const makeInteractiveSupervisor = (context: SupervisorContext) => {
  const { initial, acquireReady, logicalClosed } = context
  return Effect.fn("ServerTransport.superviseInteractive")(function* (
    operationInput: ServerFeed.InteractiveInput,
    interactive: NonNullable<NonNullable<Parameters<ServerService.Connection["run"]>[1]>["interactive"]>,
  ) {
    const firstSession = yield* Deferred.make<void>()
    const initialChange = yield* Deferred.make<void>()
    const sessions = yield* Ref.make<{
      readonly session: InteractiveSession.InteractiveSession | undefined
      readonly changed: Deferred.Deferred<void>
    }>({ session: undefined, changed: initialChange })
    const selected = yield* Ref.make<
      { readonly _tag: "thread"; readonly threadId: string } | { readonly _tag: "latest" } | undefined
    >(undefined)
    let eventDispatch = ignoreInteractiveEvent
    let feedAttached = false
    const awaitSession: Effect.Effect<InteractiveSession.InteractiveSession> = Effect.suspend(() =>
      Ref.get(sessions).pipe(
        Effect.flatMap((state) =>
          state.session === undefined
            ? Deferred.await(state.changed).pipe(Effect.andThen(awaitSession))
            : Effect.succeed(state.session),
        ),
      ),
    )
    const invalidate = (session: InteractiveSession.InteractiveSession) =>
      Effect.gen(function* () {
        const next = yield* Deferred.make<void>()
        const changed = yield* Ref.modify(sessions, (state) =>
          state.session === session ? [state.changed, { session: undefined, changed: next }] : [undefined, state],
        )
        if (changed !== undefined) yield* Deferred.succeed(changed, undefined)
      })
    const report = (event: InteractiveEvent.InteractiveEvent) => eventDispatch(event)
    const retryRead = (
      invoke: (
        session: InteractiveSession.InteractiveSession,
      ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
    ): Effect.Effect<void> =>
      Effect.suspend(() =>
        awaitSession.pipe(
          Effect.flatMap((session) =>
            invoke(session).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                if (isDisconnectedOperation(Cause.squash(cause)))
                  return invalidate(session).pipe(Effect.andThen(retryRead(invoke)))
                return Effect.sync(() =>
                  report({
                    _tag: "ExecutionFailed",
                    failure: {
                      tag: "TransportOperationFailed",
                      category: "transport-degraded",
                      message: String(Cause.squash(cause)),
                      retryable: true,
                      retry: "automatic",
                      actor: "environment",
                    },
                  }),
                )
              }),
            ),
          ),
        ),
      )
    const mutation = (
      invoke: (
        session: InteractiveSession.InteractiveSession,
      ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
    ) =>
      awaitSession.pipe(
        Effect.flatMap((session) =>
          invoke(session).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              if (isDisconnectedOperation(Cause.squash(cause)))
                return invalidate(session).pipe(
                  Effect.andThen(
                    Effect.sync(() =>
                      report({
                        _tag: "ExecutionFailed",
                        failure: {
                          tag: "TransportDisconnected",
                          category: "transport-degraded",
                          message: "Server transport disconnected; the action outcome is unknown and was not retried",
                          retryable: true,
                          retry: "automatic",
                          actor: "environment",
                        },
                      }),
                    ),
                  ),
                )
              return Effect.sync(() =>
                report({
                  _tag: "ExecutionFailed",
                  failure: {
                    tag: "TransportOperationFailed",
                    category: "transport-degraded",
                    message: String(Cause.squash(cause)),
                    retryable: true,
                    retry: "automatic",
                    actor: "environment",
                  },
                }),
              )
            }),
          ),
        ),
      )
    const stable: InteractiveSession.InteractiveSession = {
      events: (dispatch) =>
        Effect.suspend(() => {
          if (feedAttached)
            return Effect.fail(
              ProductOperation.OperationUnavailable.make({
                operation: "InteractiveSession.events",
                message: "Interactive session already has an event consumer",
              }),
            )
          feedAttached = true
          eventDispatch = dispatch
          return retryRead((session) => session.events(dispatch)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                feedAttached = false
                eventDispatch = ignoreInteractiveEvent
              }),
            ),
          )
        }),
      submit: (prompt, mode, parts, tuning, submissionId) =>
        mutation((session) => session.submit(prompt, mode, parts, tuning, submissionId)),
      shell: (threadId, command, incognito) =>
        Effect.gen(function* () {
          const launchSelection = yield* Ref.get(selected)
          const launchThreadId =
            threadId ??
            (launchSelection !== undefined && launchSelection._tag === "thread"
              ? Thread.ThreadId.make(launchSelection.threadId)
              : undefined)
          yield* mutation((session) => session.shell(launchThreadId, command, incognito))
        }),
      editQueued: (turnId, prompt) => mutation((session) => session.editQueued(turnId, prompt)),
      dequeue: (turnId) => mutation((session) => session.dequeue(turnId)),
      steerQueued: (turnId, text, requestId) => mutation((session) => session.steerQueued(turnId, text, requestId)),
      steer: (text, requestId, turnId) => mutation((session) => session.steer(text, requestId, turnId)),
      approveAuthorization: (turnId, authorizationId) =>
        mutation((session) => session.approveAuthorization(turnId, authorizationId)),
      denyAuthorization: (turnId, authorizationId) =>
        mutation((session) => session.denyAuthorization(turnId, authorizationId)),
      interruptAndSend: (prompt) => mutation((session) => session.interruptAndSend(prompt)),
      cancel: mutation((session) => session.cancel),
      quit: mutation((session) => session.quit),
      newThread: Ref.set(selected, { _tag: "latest" as const }).pipe(
        Effect.andThen(mutation((session) => session.newThread)),
      ),
      selectThread: (threadId) =>
        Effect.gen(function* () {
          yield* Ref.set(selected, { _tag: "thread" as const, threadId })
          yield* retryRead((session) => session.selectThread(threadId))
        }),
      readQueue: (threadId) => retryRead((session) => session.readQueue(threadId)),
      previewThread: (threadId, requestId) => retryRead((session) => session.previewThread(threadId, requestId)),
      reopenThread: Effect.gen(function* () {
        yield* Ref.set(selected, { _tag: "latest" as const })
        yield* retryRead((session) => session.reopenThread)
      }),
    }
    const publish = (session: InteractiveSession.InteractiveSession, first: boolean) =>
      Effect.gen(function* () {
        if (!first) {
          const selection = yield* Ref.get(selected)
          if (selection?._tag === "thread") yield* session.selectThread(selection.threadId)
          else if (selection?._tag === "latest") yield* session.reopenThread
        }
        const changed = yield* Ref.modify(sessions, (state) => [state.changed, { ...state, session }])
        yield* Deferred.succeed(changed, undefined)
        if (first) yield* Deferred.succeed(firstSession, undefined)
      })
    const runPhysical = (connection: ServerService.Connection, first: boolean) =>
      connection
        .run(operationInput, {
          interactive: (_, session) => publish(session, first).pipe(Effect.andThen(connection.closed)),
        })
        .pipe(Effect.ensuring(connection.close))
    let nextReconnectDelay = yield* Schedule.toStepWithMetadata(reconnectSchedule)
    const loop = (
      connection: ServerService.Connection | undefined,
      first: boolean,
      consecutiveFailures: number,
    ): Effect.Effect<
      void,
      ServerService.ServerServiceError | ServerService.ServerRestartRequired | ProductOperation.OperationUnavailable
    > =>
      Effect.gen(function* () {
        const acquired = yield* Effect.exit(
          connection === undefined ? acquireReady("reattach") : Effect.succeed(connection),
        )
        if (acquired._tag === "Failure") return yield* recover(acquired.cause, undefined, first, consecutiveFailures)
        const startedAt = yield* Clock.currentTimeMillis
        const outcome = yield* Effect.exit(runPhysical(acquired.value, first))
        const duration = (yield* Clock.currentTimeMillis) - startedAt
        if (outcome._tag === "Success") return
        return yield* recover(outcome.cause, duration, first, consecutiveFailures, acquired.value.connectionId)
      })
    const recover = (
      cause: Cause.Cause<
        ServerService.ServerServiceError | ServerService.ServerRestartRequired | ProductOperation.OperationUnavailable
      >,
      duration: number | undefined,
      first: boolean,
      consecutiveFailures: number,
      connectionId?: string,
    ): Effect.Effect<
      void,
      ServerService.ServerServiceError | ServerService.ServerRestartRequired | ProductOperation.OperationUnavailable
    > =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
        const failure = Cause.squash(cause)
        if (
          Schema.is(ServerService.ServerRestartRequired)(failure) ||
          (Schema.is(ServerService.ServerServiceError)(failure) && failure.reason === "incompatible-server")
        ) {
          const selection = yield* Ref.get(selected)
          return yield* ServerService.ServerRestartRequired.make({
            message: failure.message,
            ...(selection?._tag === "thread" ? { threadId: selection.threadId } : {}),
          })
        }
        if (!isDisconnectedOperation(failure) && !isReconnectableTransport(failure))
          return yield* Effect.failCause(cause)
        const current = (yield* Ref.get(sessions)).session
        if (current !== undefined) yield* invalidate(current)
        const stableConnection = duration !== undefined && duration >= reconnectStableMilliseconds
        const nextFailure = stableConnection ? 1 : consecutiveFailures + 1
        if (stableConnection) nextReconnectDelay = yield* Schedule.toStepWithMetadata(reconnectSchedule)
        if (nextFailure >= reconnectFailureLimit) {
          yield* Effect.logError("server.connection.reconnect_exhausted").pipe(
            Effect.annotateLogs({
              "rika.failure.kind": failureKind(cause),
              "rika.server.connection.duration.ms": duration ?? 0,
              "rika.server.connection.failures": nextFailure,
              ...(connectionId === undefined ? {} : { "rika.server.connection.id": connectionId }),
            }),
          )
          return yield* ProductOperation.OperationUnavailable.make({
            operation: "ServerConnection",
            message: `Server connection closed ${nextFailure} times before becoming stable`,
          })
        }
        const delay = yield* nextReconnectDelay(failure).pipe(Effect.orDie)
        yield* Effect.logWarning("server.connection.reconnecting").pipe(
          Effect.annotateLogs({
            "rika.failure.kind": failureKind(cause),
            "rika.server.connection.duration.ms": duration ?? 0,
            "rika.server.connection.retry": nextFailure,
            "rika.server.connection.retry_delay.ms": Duration.toMillis(delay.duration),
            ...(connectionId === undefined ? {} : { "rika.server.connection.id": connectionId }),
          }),
        )
        const nextFirst = first && !(yield* Deferred.isDone(firstSession))
        return yield* loop(undefined, nextFirst, nextFailure)
      })
    const supervisor = yield* Effect.forkChild(Effect.raceFirst(loop(initial, true, 0), Deferred.await(logicalClosed)))
    yield* Effect.raceFirst(
      Deferred.await(firstSession),
      Effect.raceFirst(Deferred.await(logicalClosed), Fiber.join(supervisor)),
    )
    yield* Effect.raceFirst(
      interactive(operationInput, stable),
      Effect.raceFirst(Deferred.await(logicalClosed), Fiber.join(supervisor)),
    ).pipe(Effect.ensuring(Fiber.interrupt(supervisor)))
  })
}
