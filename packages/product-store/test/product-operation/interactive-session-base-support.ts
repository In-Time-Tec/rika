import * as TurnContract from "@rika/product/turn-repository"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Result, Schema, Scope } from "effect"
import * as ThreadRepositoryContract from "@rika/product/thread-repository"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import { TestClock } from "effect/testing"
import { ExecutionIngest } from "@rika/product/product-operation"
import { Operation } from "@rika/product/product-operation"
import { createTurn, executionRoute } from "../support/product-test-current-state"
import { delegationUnit, invalidatedProjection, storeProjection } from "../support/product-test-transcript-fixture"

export const productLayer = <
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
  ThreadInteractionError extends Error = never,
  UsageError extends Error = never,
>(
  options: Operation.ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >,
): Layer.Layer<Operation.Service, Error, never> =>
  Operation.productLayer({
    ...options,
    threadSummaryRepositoryLayer:
      options.threadSummaryRepositoryLayer ??
      RuntimeFixtures.SummaryRepository.memoryLayer.pipe(
        Layer.provide(Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)),
        Layer.orDie,
      ),
    transcriptRepositoryLayer:
      options.transcriptRepositoryLayer ??
      RuntimeFixtures.TranscriptRepository.memoryLayerWithTurns.pipe(
        Layer.provide(options.turnRepositoryLayer),
        Layer.orDie,
      ),
    usageRepositoryLayer: options.usageRepositoryLayer ?? RuntimeFixtures.UsageRepository.memoryLayer.pipe(Layer.orDie),
  })

export const collectEvents = (session: Operation.InteractiveSession, events: Array<Operation.InteractiveEvent>) =>
  Effect.forkChild(session.events((event) => events.push(event))).pipe(Effect.andThen(Effect.yieldNow))

export const waitForSessions = (sessions: Ref.Ref<ReadonlyArray<Operation.InteractiveSession>>, count = 1) =>
  Effect.gen(function* () {
    while ((yield* Ref.get(sessions)).length < count) yield* Effect.yieldNow
  })

export const thread = (id: string, updatedAt: number): RuntimeFixtures.Thread.Thread => ({
  id: RuntimeFixtures.Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: updatedAt,
  updatedAt,
})

export const active = (
  threadId: RuntimeFixtures.Thread.ThreadId,
  id = "active",
): RuntimeFixtures.Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: RuntimeFixtures.Turn.TurnId.make(id),
  threadId,
  prompt: "active prompt",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: executionRoute(),
  status: "running",
  stopIntent: "none",
  createdAt: 1,
  updatedAt: 1,
  lastCursor: "active-cursor",
})

export const serverEvents = (
  events: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event>,
): ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event> =>
  events.map((event) => ({ ...event, timestampSource: "server" as const }))

export const completeServerTimeline = (
  events: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event>,
): ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event> => {
  if (events.length === 0) return events
  const stamped = serverEvents(events)
  if (stamped.some((event) => event.type === "execution.started" || event.type === "execution.accepted")) return stamped
  const first = stamped[0]!
  return [
    {
      executionId: first.executionId,
      cursor: `${first.executionId}:started`,
      sequence: 0,
      type: "execution.started",
      createdAt: first.createdAt - 1,
      timestampSource: "server",
    },
    ...stamped.map((event, index) => Object.assign({}, event, { sequence: index + 1 })),
  ]
}

export const storeCompletedTranscript = Effect.fn("InteractiveSessionTest.storeCompletedTranscript")(function* (
  transcripts: RuntimeFixtures.TranscriptRepository.Interface,
  turn: RuntimeFixtures.Turn.AgentExecutionTurn,
  cursor: string,
) {
  const projection = TranscriptFixtures.TranscriptProjection.Projection.project(String(turn.id), turn.prompt, [
    {
      cursor,
      sequence: 0,
      type: "execution.completed",
      createdAt: turn.updatedAt,
    },
  ])
  yield* storeProjection(transcripts, turn, projection, {
    consumed: { [String(turn.id)]: { cursor, sequence: 0, status: "completed" } },
    projectionVersion: ExecutionIngest.projectionVersion,
  })
})

export const completeActive = Effect.fn("InteractiveSessionTest.completeActive")(function* (
  turns: TurnContract.Interface,
  transcripts: RuntimeFixtures.TranscriptRepository.Interface,
  updatedAt: number,
) {
  const turn = yield* turns.setStatus(RuntimeFixtures.Turn.TurnId.make("active"), "completed", "done", updatedAt)
  yield* storeCompletedTranscript(transcripts, turn, "done")
  return turn
})

export interface InteractiveHarness {
  readonly session: Operation.InteractiveSession
  readonly repositories: ThreadRepositoryContract.Interface
  readonly turns: TurnContract.Interface
  readonly transcripts: TranscriptRepositoryContract.Interface
  readonly controls: Ref.Ref<ReadonlyArray<ReadonlyArray<unknown>>>
  readonly hiddenExecutions: Ref.Ref<ReadonlySet<string>>
  readonly older: RuntimeFixtures.Thread.Thread
  readonly latest: RuntimeFixtures.Thread.Thread
}

export const makeHarness: (
  pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event>,
  stalePageCursor?: boolean,
  turnPageRequests?: Ref.Ref<ReadonlyArray<TurnContract.PageCursor | undefined>>,
  cancelFailure?: boolean,
  initialTurnsCompleted?: boolean,
  completion?: {
    readonly release: Deferred.Deferred<void, never>
    readonly finished: Deferred.Deferred<void, never>
    readonly finalTurnId: RuntimeFixtures.Turn.TurnId
  },
) => Effect.Effect<InteractiveHarness, object, Scope.Scope> = Effect.fn("InteractiveSessionTest.makeHarness")(
  function* (
    pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event>,
    stalePageCursor: boolean = false,
    turnPageRequests?: Ref.Ref<ReadonlyArray<TurnContract.PageCursor | undefined>>,
    cancelFailure: boolean = false,
    initialTurnsCompleted: boolean = false,
    completion?: {
      readonly release: Deferred.Deferred<void, never>
      readonly finished: Deferred.Deferred<void, never>
      readonly finalTurnId: RuntimeFixtures.Turn.TurnId
    },
  ) {
    const older = thread("older", 1)
    const latest = thread("latest", 2)
    const initialTurns = [active(older.id), active(latest.id, "latest-active")].map((turn) =>
      initialTurnsCompleted
        ? Object.assign({}, turn, {
            status: "completed" as const,
            lastCursor: `${turn.id}-completed`,
            updatedAt: 2,
          })
        : turn,
    )
    const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory([older, latest])
    const turns = yield* RuntimeFixtures.TurnRepository.makeMemory(initialTurns)
    const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
    const controls = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
    const hiddenExecutions = yield* Ref.make<ReadonlySet<string>>(new Set())
    const transcripts = yield* RuntimeFixtures.TranscriptRepository.makeMemory({ turns })
    if (initialTurnsCompleted)
      yield* Effect.forEach(initialTurns, (turn) => storeCompletedTranscript(transcripts, turn, turn.lastCursor!), {
        discard: true,
      })
    const record = (...call: ReadonlyArray<unknown>) => Ref.update(controls, (calls) => [...calls, call])
    const backend = RuntimeFixtures.ExecutionBackend.Service.of({
      invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
      createFanOut: () => Effect.die("unused"),
      inspectFanOut: () => Effect.die("unused"),
      cancelFanOut: () => Effect.die("unused"),
      registerWorkflows: () => Effect.die("unused"),
      startWorkflow: () => Effect.die("unused"),
      inspectWorkflow: () => Effect.die("unused"),
      cancelWorkflow: () => Effect.die("unused"),
      start: (input) =>
        completion !== undefined
          ? record("start", input.turnId).pipe(
              Effect.tap(() =>
                input.turnId === completion.finalTurnId
                  ? Deferred.succeed(completion.finished, undefined)
                  : Effect.void,
              ),
              Effect.as({
                turnId: input.turnId,
                status: "completed" as const,
                events: serverEvents([
                  {
                    executionId: input.turnId,
                    cursor: "queued-started",
                    sequence: 0,
                    type: "execution.started",
                    createdAt: 2,
                  },
                  {
                    executionId: input.turnId,
                    cursor: "queued-done",
                    sequence: 1,
                    type: "execution.completed",
                    createdAt: 3,
                  },
                ]),
              }),
            )
          : Effect.die("unused"),
      ...(completion !== undefined
        ? {
            follow: (
              turnId: string,
              checkpoint: string | RuntimeFixtures.ExecutionBackend.ExecutionCheckpoint | undefined,
              onEvent?: (event: RuntimeFixtures.ExecutionBackend.Event) => void,
            ) => {
              const afterCursor = typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor
              const output: RuntimeFixtures.ExecutionBackend.Event = {
                executionId: turnId,
                cursor: "resumed-output",
                sequence: 2,
                type: "model.output.completed",
                createdAt: 2,
                timestampSource: "server",
                text: "created file",
              }
              const completed: RuntimeFixtures.ExecutionBackend.Event = {
                executionId: turnId,
                cursor: "resumed-done",
                sequence: 3,
                type: "execution.completed",
                createdAt: 3,
                timestampSource: "server",
              }
              return record("follow", turnId, afterCursor).pipe(
                Effect.andThen(turnId === "active" ? Deferred.await(completion.release) : Effect.void),
                Effect.tap(() => Effect.sync(() => onEvent?.(output))),
                Effect.tap(() => Effect.sync(() => onEvent?.(completed))),
                Effect.as({ turnId, status: "completed" as const, events: [output, completed] }),
              )
            },
          }
        : {}),
      inspect: (turnId) =>
        Ref.get(hiddenExecutions).pipe(
          Effect.map((hidden) =>
            turnId === "recorded-shell" || hidden.has(turnId)
              ? undefined
              : { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] },
          ),
        ),
      steer: (turnId, text, idempotencyIdentity) =>
        record("steer", turnId, text, idempotencyIdentity).pipe(
          Effect.as({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
        ),
      cancel: (turnId) =>
        record("cancel", turnId).pipe(
          Effect.andThen(
            cancelFailure
              ? Effect.fail(RuntimeFixtures.ExecutionBackend.BackendError.make({ message: "cancel unavailable" }))
              : Effect.void,
          ),
          Effect.as({
            turnId,
            status: "cancelled" as const,
            events: serverEvents([
              {
                executionId: turnId,
                cursor: "cancel-cursor",
                sequence: 1,
                type: "execution.cancelled",
                createdAt: 1,
              },
            ]),
          }),
        ),
      replay: (turnId, cursor) =>
        record("replay", turnId, cursor).pipe(
          Effect.as({
            turnId,
            status: "running" as const,
            events:
              cursor === undefined
                ? serverEvents([
                    {
                      executionId: turnId,
                      cursor: "active-cursor",
                      sequence: 0,
                      type: "execution.started",
                      createdAt: 0,
                    },
                  ])
                : [],
            lastCursor: cursor ?? "active-cursor",
          }),
        ),
      ...(pagedEvents === undefined
        ? {}
        : {
            pageEvents: (turnId: string, direction: "forward" | "backward", cursor?: string, limit = 200) => {
              let boundary: number
              if (cursor === undefined) {
                boundary = direction === "forward" ? 0 : pagedEvents.length
              } else {
                boundary = pagedEvents.findIndex((event) => event.cursor === cursor)
                if (direction === "forward") boundary += 1
              }
              const page =
                direction === "forward"
                  ? pagedEvents.slice(boundary, boundary + limit)
                  : pagedEvents.slice(Math.max(0, boundary - limit), boundary)
              const hasMore =
                direction === "forward" ? boundary + page.length < pagedEvents.length : boundary > page.length
              return record("page", turnId, direction, cursor, limit).pipe(
                Effect.as({
                  events: page,
                  hasMore,
                  ...(page[0] === undefined
                    ? {}
                    : {
                        oldestCursor:
                          direction === "backward" && stalePageCursor && cursor !== undefined ? cursor : page[0].cursor,
                      }),
                  ...(page.at(-1) === undefined
                    ? {}
                    : {
                        newestCursor:
                          direction === "forward" && stalePageCursor && cursor !== undefined
                            ? cursor
                            : page.at(-1)!.cursor,
                      }),
                }),
              )
            },
          }),
      resolveInvocationSource: () => Effect.die("unused"),
    })
    const selectionTurns: TurnContract.Interface =
      turnPageRequests === undefined
        ? turns
        : {
            ...turns,
            page: (threadId, options) =>
              Ref.update(turnPageRequests, (requests) => [...requests, options?.before]).pipe(
                Effect.andThen(turns.page(threadId, options)),
              ),
          }
    const layer = productLayer({
      repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
      turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, selectionTurns),
      transcriptRepositoryLayer: Layer.succeed(RuntimeFixtures.TranscriptRepository.Service, transcripts),
      backendLayer: Layer.succeed(RuntimeFixtures.ExecutionBackend.Service, backend),
      defaultWorkspace: "/work",
      makeThreadId: Effect.die("unused"),
      makeTurnId: Effect.succeed(RuntimeFixtures.Turn.TurnId.make("pending")),
      interactive: (_, session) =>
        Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
    })
    const context = yield* Layer.build(layer)
    const operation = Context.get(context, Operation.Service)
    yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
    yield* waitForSessions(sessions)
    yield* Ref.set(controls, [])
    const session = (yield* Ref.get(sessions))[0]
    if (session === undefined) return yield* Effect.die("Missing interactive session")
    return { session, repositories, turns, transcripts, controls, hiddenExecutions, older, latest }
  },
)

export { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Result, Schema }
export { TestClock }
export { RuntimeFixtures }
export { TranscriptFixtures }
export { ExecutionIngest, Operation, TurnContract }
export { createTurn, executionRoute }
export { delegationUnit, invalidatedProjection, storeProjection }
