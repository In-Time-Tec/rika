import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionStatus from "@rika/product/execution-status"
import { Fixtures } from "./execution-ingest-support"
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import * as TurnContract from "@rika/product/turn-repository"
import { executionRoute } from "../../../product-store/test/support/product-test-current-state"
import { storeProjection } from "../../../product-store/test/support/product-test-transcript-fixture"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

export interface ScriptEntry {
  readonly events: ReadonlyArray<Fixtures.ExecutionEvent.Event>
  readonly status: Fixtures.ExecutionStatus.Status
  readonly children?: ReadonlyArray<string>
  readonly hold?: Deferred.Deferred<void>
  readonly ignoreCursor?: boolean
  readonly pages?: (after: string | undefined) => Fixtures.ExecutionEvent.EventPage
}

export interface Followed {
  readonly executionId: string
  readonly after: string | undefined
}

export interface DeltaWrite {
  readonly upsert: ReadonlyArray<string>
  readonly remove: ReadonlyArray<string>
}

export interface Harness {
  readonly ingest: ExecutionIngest.Interface
  readonly transcripts: Fixtures.TranscriptRepository.Interface
  readonly turns: TurnContract.Interface
  readonly turn: Fixtures.Turn.AgentExecutionTurn
  readonly follows: ReadonlyArray<Followed>
  readonly inspections: ReadonlyArray<string>
  readonly commits: ReadonlyArray<number>
  readonly writes: ReadonlyArray<DeltaWrite>
  readonly usage: import("@rika/product/usage-repository").Interface
  readonly refolds: ReadonlyArray<ExecutionIngest.Refold>
  readonly projectionChanges: ReadonlyArray<ExecutionIngest.ProjectionChange>
  readonly projectionWatch: ExecutionIngest.ProjectionWatch
}

type MakeHarnessOptions = {
  readonly script: Readonly<Record<string, ScriptEntry>>
  readonly turnStatus?: Fixtures.ExecutionStatus.Status
  readonly stored?: Fixtures.TranscriptProjectionModel.Projection
  readonly executionCheckpoints?: ReadonlyArray<Fixtures.TranscriptPage.ExecutionCheckpoint>
  readonly consumed?: Readonly<
    Record<
      string,
      { readonly cursor: string; readonly sequence: number; readonly status?: "completed" | "failed" | "cancelled" }
    >
  >
  readonly executionStates?: Readonly<Record<string, Fixtures.TranscriptProjectionModel.ProjectionState>>
  readonly storedProjectionVersion?: number
  readonly exposeStored?: (stored: Fixtures.TranscriptPage.Projection) => Fixtures.TranscriptPage.Projection
  readonly commitEvents?: number
  readonly watchCapacity?: number
  readonly commitOutcome?: "failure" | "stale"
  readonly commitFailures?: Ref.Ref<number>
  readonly commitGate?: (write: number) => Effect.Effect<void>
  readonly pageHold?: { readonly after: string; readonly open: Deferred.Deferred<void> }
  readonly onFailure?: (failure: ExecutionIngest.Failure) => void
  readonly onCommitted?: (commit: ExecutionIngest.Commit) => void
}

export const makeHarness: (options: MakeHarnessOptions) => Effect.Effect<Harness, object, Scope.Scope> = Effect.fn(
  "ExecutionIngestTest.makeHarness",
)(function* (options) {
  const turn = ExecutionFixtures.makeTurn(options.turnStatus ?? "completed")
  const turns = yield* Fixtures.TurnRepository.makeMemory([turn])
  const usage = Context.get(yield* Layer.build(Fixtures.UsageRepository.memoryLayer), Fixtures.UsageRepository.Service)
  if (options.consumed !== undefined) {
    const observations = Object.entries(options.consumed).flatMap(([executionId, consumed]) =>
      (options.script[executionId]?.events ?? [])
        .filter((candidate) => candidate.sequence <= consumed.sequence)
        .map((candidate) => ({
          threadId: String(ExecutionFixtures.threadId),
          turnId: String(ExecutionFixtures.rootId),
          event: candidate,
        })),
    )
    const folded = Fixtures.UsageCost.foldBatch(Fixtures.UsageCost.empty, observations)
    if (folded._tag === "Failure") return yield* Effect.die(folded.failure)
    yield* usage.admitSource(
      String(ExecutionFixtures.rootId),
      String(ExecutionFixtures.rootId),
      String(ExecutionFixtures.threadId),
    )
    yield* usage.commitSource(
      String(ExecutionFixtures.rootId),
      String(ExecutionFixtures.rootId),
      0,
      Fixtures.UsageCost.serialize(folded.success),
      {
        ...Fixtures.UsageCost.materialize(
          folded.success,
          String(ExecutionFixtures.rootId),
          String(ExecutionFixtures.threadId),
        ),
        sourceComplete: false,
      },
    )
  }
  const memory = yield* Fixtures.TranscriptRepository.makeMemory({ turns })
  if (options.stored !== undefined)
    yield* storeProjection(memory, turn, options.stored, {
      ...(options.executionCheckpoints === undefined ? {} : { executionCheckpoints: options.executionCheckpoints }),
      ...(options.consumed === undefined ? {} : { consumed: options.consumed }),
      ...(options.executionStates === undefined ? {} : { executionStates: options.executionStates }),
      projectionVersion: options.storedProjectionVersion ?? Fixtures.TranscriptRepository.invalidatedProjectionVersion,
    })
  const commits: Array<number> = []
  const writes: Array<DeltaWrite> = []
  const transcripts = Fixtures.TranscriptRepository.Service.of({
    ...memory,
    get: (turnId) =>
      memory
        .get(turnId)
        .pipe(
          Effect.map((stored) =>
            stored === undefined || options.exposeStored === undefined ? stored : options.exposeStored(stored),
          ),
        ),
    commitDelta: (committedTurn, state, delta, commitOptions) => {
      writes.push({ upsert: delta.upsert.map((unit) => unit.key), remove: [...delta.remove] })
      const gate = options.commitGate?.(writes.length) ?? Effect.void
      const outcome =
        options.commitFailures === undefined
          ? Effect.succeed(options.commitOutcome)
          : Ref.modify(options.commitFailures, (remaining) =>
              remaining > 0 ? (["failure", remaining - 1] as const) : ([undefined, remaining] as const),
            )
      const write = gate.pipe(
        Effect.andThen(outcome),
        Effect.flatMap((selected) => {
          if (selected === "failure")
            return Effect.fail(
              Fixtures.TranscriptRepository.RepositoryError.make({ message: "injected transcript write failure" }),
            )
          if (selected === "stale") return Effect.succeed("stale" as const)
          return memory.commitDelta(committedTurn, state, delta, commitOptions)
        }),
      )
      return write.pipe(
        Effect.tap((result) =>
          result === "committed" ? Effect.sync(() => commits.push(state.revision)) : Effect.void,
        ),
      )
    },
    replaceForRefold: (refoldedTurn, projection, refoldOptions) =>
      memory
        .replaceForRefold(refoldedTurn, projection, refoldOptions)
        .pipe(
          Effect.tap((result) =>
            result._tag === "Committed" ? Effect.sync(() => commits.push(projection.revision)) : Effect.void,
          ),
        ),
  })
  const follows: Array<Followed> = []
  const inspections: Array<string> = []
  const backend = Fixtures.ExecutionBackend.Service.of({
    invokeChild: () => Effect.die("unused"),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    replay: () => Effect.die("unused"),
    resolveInvocationSource: () => Effect.die("unused"),
    inspect: (executionId) =>
      Effect.sync(() => {
        inspections.push(executionId)
        const entry = options.script[executionId]
        if (entry === undefined) return undefined
        return {
          turnId: executionId,
          status: entry.status,
          ...(entry.events.at(-1) === undefined ? {} : { lastCursor: entry.events.at(-1)!.cursor }),
          waits: [],
          pendingTools: [],
          children: (entry.children ?? []).map((id) => ({
            executionId: id,
            status: options.script[id]?.status ?? ("running" as const),
          })),
        }
      }),
    pageEvents: (executionId, _direction, cursor) =>
      Effect.gen(function* () {
        const pageHold = options.pageHold
        if (pageHold !== undefined && cursor === pageHold.after) yield* Deferred.await(pageHold.open)
        const entry = options.script[executionId]
        if (entry?.pages !== undefined) return entry.pages(cursor)
        const events = entry?.events ?? []
        const boundary = cursor === undefined ? -1 : events.findIndex((candidate) => candidate.cursor === cursor)
        return {
          events: events.slice(boundary + 1),
          hasMore: false,
          ...(events.at(-1) === undefined ? {} : { newestCursor: events.at(-1)!.cursor }),
        }
      }),
    follow: (executionId, afterCursor, onEvent) =>
      Effect.gen(function* () {
        const after = typeof afterCursor === "string" ? afterCursor : afterCursor?.cursor
        follows.push({ executionId, after })
        const entry = options.script[executionId]
        if (entry === undefined)
          return yield* Fixtures.ExecutionBackend.BackendError.make({ message: `ExecutionNotFound ${executionId}` })
        const boundary =
          after === undefined || entry.ignoreCursor === true
            ? -1
            : entry.events.findIndex((candidate) => candidate.cursor === after)
        const pending = entry.events.slice(boundary + 1)
        for (const pendingEvent of pending) onEvent?.(pendingEvent)
        if (entry.hold !== undefined) yield* Deferred.await(entry.hold)
        return { turnId: executionId, status: entry.status, events: pending }
      }),
  })
  const refolds: Array<ExecutionIngest.Refold> = []
  const ingest = yield* ExecutionIngest.make({
    backend,
    transcripts,
    turns,
    usage,
    onRefold: (refold) => refolds.push(refold),
    ...(options.commitEvents === undefined ? {} : { commitEvents: options.commitEvents }),
    ...(options.watchCapacity === undefined ? {} : { watchCapacity: options.watchCapacity }),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
  })
  const projectionChanges: Array<ExecutionIngest.ProjectionChange> = []
  const projectionWatch = yield* ingest.watchThread(ExecutionFixtures.threadId)
  yield* projectionWatch.changes.pipe(
    Stream.runForEach((change) => Effect.sync(() => projectionChanges.push(change))),
    Effect.forkScoped,
  )
  return {
    ingest,
    transcripts,
    turns,
    turn,
    follows,
    inspections,
    commits,
    writes,
    usage,
    refolds,
    projectionChanges,
    projectionWatch,
  }
})

export const followsOf = (follows: ReadonlyArray<Followed>, executionId: string) =>
  follows.filter((followed) => followed.executionId === executionId)

export const settle = (ingest: ExecutionIngest.Interface) =>
  ingest.settled(ExecutionFixtures.rootId).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow))
