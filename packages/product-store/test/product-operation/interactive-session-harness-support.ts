import type { InteractiveSession } from "@rika/product/interactive-session"
import { Service } from "@rika/product/product-operation-service"
import * as ThreadRepositoryContract from "@rika/product/thread-repository"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as TurnContract from "@rika/product/turn-repository"
import { Context, Effect, Deferred, Layer, Ref, Scope, Stream } from "effect"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { productLayer, thread, active, waitForSessions } from "./interactive-session-base-support"
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

const makeHarnessImplementation: (
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
      yield* Effect.forEach(
        initialTurns,
        (turn) => storeCompletedTranscript(transcripts, turn, `${turn.id}-completed`),
        { discard: true },
      )
    const record = (...call: ReadonlyArray<unknown>) => Ref.update(controls, (calls) => [...calls, call])
    const backend = RuntimeFixtures.ExecutionGateway.Service.of({
      startTurn: (input) =>
        completion !== undefined
          ? record("startTurn", input.turnId).pipe(
              Effect.tap(() =>
                input.turnId === completion.finalTurnId
                  ? Deferred.succeed(completion.finished, undefined)
                  : Effect.void,
              ),
              Effect.as({ runId: `${input.turnId}-run`, turnId: input.turnId, threadId: input.threadId }),
            )
          : Effect.die("unused"),
      watchTurn: (link, cursor) =>
        completion !== undefined
          ? Stream.unwrap(
              Effect.gen(function* () {
                yield* record("watchTurn", link.turnId, cursor)
                if (link.turnId === "active") yield* Deferred.await(completion.release)
                const output: RuntimeFixtures.ExecutionEvent.Event = {
                  executionId: link.runId,
                  cursor: "resumed-output",
                  sequence: 2,
                  type: "model.output.completed",
                  createdAt: 2,
                  timestampSource: "baton",
                  text: "created file",
                }
                const completed: RuntimeFixtures.ExecutionEvent.Event = {
                  executionId: link.runId,
                  cursor: "resumed-done",
                  sequence: 3,
                  type: "execution.completed",
                  createdAt: 3,
                  timestampSource: "baton",
                }
                return Stream.fromIterable([output, completed])
              }),
            )
          : Stream.empty,
      inspectTurn: (link) =>
        Ref.get(hiddenExecutions).pipe(
          Effect.map((hidden) =>
            link.turnId === "recorded-shell" || hidden.has(link.turnId)
              ? { status: "unavailable" as const }
              : { status: "running" as const },
          ),
        ),
      steerTurn: (link, input) => record("steerTurn", link.turnId, input.text, input.idempotencyKey),
      cancelTurn: (link) =>
        record("cancelTurn", link.turnId).pipe(
          Effect.andThen(
            cancelFailure
              ? Effect.fail(RuntimeFixtures.ExecutionGateway.CancelTurnFailure.make({ message: "cancel unavailable" }))
              : Effect.void,
          ),
        ),
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
      backendLayer: Layer.succeed(RuntimeFixtures.ExecutionGateway.Service, backend),
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

type HarnessCompletion = {
  readonly release: Deferred.Deferred<void, never>
  readonly finished: Deferred.Deferred<void, never>
  readonly finalTurnId: RuntimeFixtures.Turn.TurnId
}
type HarnessResult = ReturnType<typeof makeHarnessImplementation>

export function makeHarness(
  pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>,
  stalePageCursor?: boolean,
  turnPageRequests?: Ref.Ref<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>>,
  cancelFailure?: boolean,
  initialTurnsCompleted?: boolean,
  completion?: HarnessCompletion,
): HarnessResult
export function makeHarness(
  stalePageCursor?: boolean,
  turnPageRequests?: Ref.Ref<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>>,
  cancelFailure?: boolean,
  initialTurnsCompleted?: boolean,
  completion?: HarnessCompletion,
): (pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>) => HarnessResult
export function makeHarness(
  pagedEventsOrStale?: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> | boolean,
  staleOrRequests?: boolean | Ref.Ref<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>>,
  requestsOrCancel?: Ref.Ref<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>> | boolean,
  cancelOrInitial?: boolean,
  initialOrCompletion?: boolean | HarnessCompletion,
  completion?: HarnessCompletion,
): HarnessResult | ((pagedEvents?: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>) => HarnessResult) {
  if (typeof pagedEventsOrStale === "boolean") {
    if (
      staleOrRequests === undefined ||
      typeof staleOrRequests === "boolean" ||
      typeof requestsOrCancel !== "boolean" ||
      cancelOrInitial === undefined ||
      typeof initialOrCompletion !== "object"
    )
      throw new Error("Invalid interactive harness arguments")
    return (pagedEvents) =>
      makeHarnessImplementation(
        pagedEvents,
        pagedEventsOrStale,
        staleOrRequests,
        requestsOrCancel,
        cancelOrInitial,
        initialOrCompletion,
      )
  }
  if (
    (staleOrRequests !== undefined && typeof staleOrRequests !== "boolean") ||
    (requestsOrCancel !== undefined && typeof requestsOrCancel !== "object") ||
    (cancelOrInitial !== undefined && typeof cancelOrInitial !== "boolean") ||
    (initialOrCompletion !== undefined &&
      typeof initialOrCompletion !== "boolean" &&
      typeof initialOrCompletion !== "object")
  )
    throw new Error("Invalid interactive harness arguments")
  return makeHarnessImplementation(
    pagedEventsOrStale,
    staleOrRequests,
    requestsOrCancel,
    cancelOrInitial,
    typeof initialOrCompletion === "boolean" ? initialOrCompletion : undefined,
    typeof initialOrCompletion === "object" ? initialOrCompletion : completion,
  )
}
