import type { InteractiveSession } from "@rika/product/interactive-session"
import { Service } from "@rika/product/product-operation-service"
import * as ThreadRepositoryContract from "@rika/product/thread-repository"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as TurnContract from "@rika/product/turn-repository"
import { Context, Effect, Deferred, Layer, Ref, Scope } from "effect"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { productLayer, thread, active, serverEvents, waitForSessions } from "./interactive-session-base-support"
import { storeCompletedTranscript } from "./interactive-session-completion-support"

export interface InteractiveHarness {
  readonly session: InteractiveSession
  readonly repositories: ThreadRepositoryContract.Interface
  readonly turns: TurnContract.Interface
  readonly transcripts: TranscriptRepositoryContract.Interface
  readonly controls: Ref.Ref<ReadonlyArray<ReadonlyArray<unknown>>>
  readonly hiddenExecutions: Ref.Ref<ReadonlySet<string>>
  readonly older: RuntimeFixtures.Thread.Thread
  readonly latest: RuntimeFixtures.Thread.Thread
}

export const makeHarness: (
  pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>,
  stalePageCursor?: boolean,
  turnPageRequests?: Ref.Ref<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>>,
  cancelFailure?: boolean,
  initialTurnsCompleted?: boolean,
  completion?: {
    readonly release: Deferred.Deferred<void, never>
    readonly finished: Deferred.Deferred<void, never>
    readonly finalTurnId: RuntimeFixtures.Turn.TurnId
  },
) => Effect.Effect<InteractiveHarness, object, Scope.Scope> = Effect.fn("InteractiveSessionTest.makeHarness")(
  function* (
    pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>,
    stalePageCursor: boolean = false,
    turnPageRequests?: Ref.Ref<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>>,
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
    const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
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
              checkpoint: string | RuntimeFixtures.ExecutionEvent.ExecutionCheckpoint | undefined,
              onEvent?: (event: RuntimeFixtures.ExecutionEvent.Event) => void,
            ) => {
              const afterCursor = typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor
              const output: RuntimeFixtures.ExecutionEvent.Event = {
                executionId: turnId,
                cursor: "resumed-output",
                sequence: 2,
                type: "model.output.completed",
                createdAt: 2,
                timestampSource: "server",
                text: "created file",
              }
              const completed: RuntimeFixtures.ExecutionEvent.Event = {
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
    const operation = Context.get(context, Service)
    yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
    yield* waitForSessions(sessions)
    yield* Ref.set(controls, [])
    const session = (yield* Ref.get(sessions))[0]
    if (session === undefined) return yield* Effect.die("Missing interactive session")
    return { session, repositories, turns, transcripts, controls, hiddenExecutions, older, latest }
  },
)
