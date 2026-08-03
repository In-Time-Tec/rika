import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product/usage-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionIdentifier from "@rika/product/execution-identifier"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as UsageProjection from "../../usage/usage-projection"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import { persistedThreadUsage } from "../interactive/interactive-session-transcript-runtime"
import { readThreadContext as readAuthoritativeThreadContext } from "../interactive/interactive-thread-context"
import type { Commit, Refold } from "../../execution/ingest/execution-ingest-commit"
import { Cause, Effect, Queue, Result, Scope } from "effect"
import { failureKind, operationError, OperationError } from "../operation-error"

const undeliveredEventsImpl = (
  events: ReadonlyArray<ExecutionEvent.Event>,
  delivered: ReadonlySet<string>,
): ReadonlyArray<ExecutionEvent.Event> =>
  events.filter((event) => !delivered.has(event.cursor)).toSorted((left, right) => left.sequence - right.sequence)

export const undeliveredEvents: {
  (arg1: ReadonlySet<string>): (arg0: ReadonlyArray<ExecutionEvent.Event>) => ReturnType<typeof undeliveredEventsImpl>
  (arg0: ReadonlyArray<ExecutionEvent.Event>, arg1: ReadonlySet<string>): ReturnType<typeof undeliveredEventsImpl>
} = Function.dual(2, undeliveredEventsImpl)

interface ProductOperationIngest {
  readonly executionIngest: ExecutionIngest.Interface
  readonly ensureIngest: (threadId: string, turnId: string) => Effect.Effect<void, OperationError>
  readonly awaitIngestSettled: (turnId: string) => Effect.Effect<void, OperationError>
  readonly flushIngest: (turnId: string) => Effect.Effect<void, OperationError>
  readonly deliverResultEvents: (
    turnId: string,
    events: ReadonlyArray<ExecutionEvent.Event>,
    delivered?: ReadonlySet<string>,
  ) => void
  readonly titleExecutionId: (turnId: Turn.TurnId) => string
  readonly commitUsageSource: (
    sourceId: string,
    threadId: string,
    turnId: string,
    events: ReadonlyArray<ExecutionEvent.Event>,
    terminal: boolean,
  ) => Effect.Effect<unknown, Error>
  readonly publishThreadUsage: (value: UsageSnapshot.TurnUsage | undefined) => Effect.Effect<void, Error>
  readonly readThreadContext: (
    threadId: string,
  ) => Effect.Effect<import("../interactive/interactive-thread-context").ThreadContext, Error>
}

export const makeProductOperationIngest = (input: any): Effect.Effect<ProductOperationIngest, Error, never> =>
  Effect.gen(function* () {
    const {
      acquiredBackend: rawBackend,
      usageRepository: rawUsageRepository,
      ownerScope: rawOwnerScope,
      publishInteractiveActivity,
      ingestFailureMessage,
    } = input
    const ownerScope: Scope.Scope = rawOwnerScope
    const acquiredBackend: import("@rika/product/execution-service").Interface = rawBackend
    const usageRepository: UsageRepository.Interface = rawUsageRepository
    const turns: TurnRepository.Interface = input.turns
    const titleExecutionId = (turnId: Turn.TurnId) =>
      ExecutionIdentifier.AgentDepth.childExecutionId(String(turnId), "title")
    const readThreadContext = (threadId: string) =>
      readAuthoritativeThreadContext({ threadId, turns, usage: usageRepository })
    const publishThreadUsage = Effect.fn("ProductOperation.publishThreadUsage")(function* (
      value: UsageSnapshot.TurnUsage | undefined,
    ) {
      if (value === undefined) return
      const thread = yield* usageRepository.readThread(value.threadId)
      const context = yield* readThreadContext(value.threadId).pipe(
        Effect.orElseSucceed(() => ({ _tag: "Unavailable" }) as const),
      )
      const global = yield* usageRepository.readGlobal
      if (
        context._tag === "Unavailable" &&
        thread.costNanoUsd === undefined &&
        thread.tokens === undefined &&
        thread.activeMillis === undefined
      )
        return
      publishInteractiveActivity(0, {
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 0,
        threadId: Thread.ThreadId.make(value.threadId),
        revision: thread.revision,
        ...persistedThreadUsage(thread, context),
      })
      if (value.costNanoUsd !== undefined && thread.costNanoUsd !== undefined && global.costNanoUsd !== undefined)
        publishInteractiveActivity(0, {
          _tag: "TitleCostUpdated",
          threadId: Thread.ThreadId.make(value.threadId),
          turnId: Turn.TurnId.make(value.turnId),
          turnCostUsd: value.costNanoUsd / 1_000_000_000,
          threadCostUsd: thread.costNanoUsd / 1_000_000_000,
          globalCostUsd: global.costNanoUsd / 1_000_000_000,
        })
    })
    const publishUnavailableThreadUsage = Effect.fn("ProductOperation.publishUnavailableThreadUsage")(function* (
      threadId: Thread.ThreadId,
    ) {
      const thread = yield* usageRepository.readThread(String(threadId))
      publishInteractiveActivity(0, {
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 0,
        threadId,
        revision: thread.revision,
        context: { _tag: "Unavailable" },
        cost: { _tag: "Unavailable" },
        tokens: { _tag: "Unavailable" },
        time: { _tag: "Unavailable" },
      })
    })
    const commitUsageSource = Effect.fn("ProductOperation.commitUsageSource")(function* (
      sourceId: string,
      threadId: string,
      turnId: string,
      events: ReadonlyArray<ExecutionEvent.Event>,
      terminal: boolean,
    ) {
      yield* usageRepository.admitSource(sourceId, turnId, threadId)
      while (true) {
        const stored = yield* usageRepository.loadSourceFold(sourceId, turnId)
        if (stored === undefined)
          return yield* UsageRepository.RepositoryError.make({ message: `Usage source ${sourceId} was not admitted` })
        const decoded =
          stored.foldJson === undefined ? Result.succeed(UsageSnapshot.empty) : UsageCodec.deserialize(stored.foldJson)
        if (Result.isFailure(decoded)) return yield* decoded.failure
        const folded = UsageProjection.foldBatch(
          decoded.success,
          events.map((event) => ({ threadId, turnId, event })),
          terminal ? new Set([sourceId]) : new Set(),
        )
        if (Result.isFailure(folded)) return yield* folded.failure
        const foldJson = UsageCodec.serialize(folded.success)
        const totals = { ...UsageProjection.materialize(folded.success, turnId, threadId), sourceComplete: terminal }
        if (
          foldJson === stored.foldJson &&
          (yield* usageRepository.readSource(sourceId, turnId))?.sourceComplete === terminal
        )
          return yield* usageRepository.readSource(sourceId, turnId)
        const committed = yield* usageRepository.commitSource(sourceId, turnId, stored.revision, foldJson, totals)
        if (committed._tag === "Applied") return committed.value
      }
    })
    const usageCommits = yield* Queue.unbounded<Commit>()
    const refoldingRoots = new Map<string, number>()
    const transcripts: TranscriptRepository.Interface = input.transcripts
    const executionIngest = yield* ExecutionIngest.make({
      backend: acquiredBackend,
      transcripts,
      turns,
      usage: usageRepository,
      onCommitted: (commit) => Queue.offerUnsafe(usageCommits, commit),
      onRefold: (refold: Refold) => {
        const key = String(refold.threadId)
        const current = refoldingRoots.get(key) ?? 0
        const next = refold.phase === "started" ? current + 1 : Math.max(0, current - 1)
        if (next === 0) refoldingRoots.delete(key)
        else refoldingRoots.set(key, next)
        if (next > 0 === current > 0) return
        publishInteractiveActivity(0, {
          _tag: "ThreadRefolding",
          selectionEpoch: 0,
          threadId: refold.threadId,
          refolding: next > 0,
        })
      },
      onFailure: (failure: any) =>
        publishInteractiveActivity(0, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: failure.threadId,
          turnId: failure.turnId,
          message: ingestFailureMessage,
        }),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope))
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const commit = yield* Queue.take(usageCommits)
          if (commit.refolded) {
            const sourceId = titleExecutionId(commit.rootTurnId)
            const inspection = yield* acquiredBackend.inspect(sourceId, ExecutionIdentifier.executionReference)
            if (inspection !== undefined) {
              if (!ExecutionStatus.isTerminalStatus(inspection.status))
                return yield* operationError(`Title usage source ${sourceId} is nonterminal after root refold`)
              const replay = yield* acquiredBackend.replay(sourceId, undefined, ExecutionIdentifier.executionReference)
              if (replay.status !== inspection.status)
                return yield* operationError(`Title usage source ${sourceId} has contradictory terminal status`)
              yield* commitUsageSource(
                sourceId,
                String(commit.threadId),
                String(commit.rootTurnId),
                replay.events,
                true,
              )
            }
          }
          if (commit.usageChanged || commit.refolded)
            yield* commit.usageDegraded
              ? publishUnavailableThreadUsage(commit.threadId)
              : usageRepository
                  .readTurn(String(commit.rootTurnId))
                  .pipe(Effect.flatMap((value) => publishThreadUsage(value)))
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logError("usage-projection.publish.failed").pipe(
                Effect.annotateLogs({
                  "rika.failure.kind": failureKind(cause),
                  "rika.failure.cause": Cause.pretty(cause),
                }),
              ),
        ),
      ),
      ownerScope,
    )
    const ensureIngest = (threadId: any, turnId: any) =>
      executionIngest
        .ensure({ threadId, turnId })
        .pipe(Effect.mapError((failure: any) => operationError(String(failure.message), failure)))
    const awaitIngestSettled = (turnId: any) =>
      executionIngest
        .settled(turnId)
        .pipe(Effect.mapError((failure: any) => operationError(String(failure.message), failure)))
    const flushIngest = (turnId: any) =>
      executionIngest
        .flush(turnId)
        .pipe(Effect.mapError((failure: any) => operationError(String(failure.message), failure)))
    const deliverResultEvents = (
      turnId: any,
      events: ReadonlyArray<ExecutionEvent.Event>,
      delivered: ReadonlySet<string> = new Set(),
    ) => {
      for (const event of undeliveredEvents(events, delivered)) executionIngest.deliver(turnId, event)
    }
    return {
      executionIngest,
      ensureIngest,
      awaitIngestSettled,
      flushIngest,
      deliverResultEvents,
      titleExecutionId,
      commitUsageSource,
      publishThreadUsage,
      readThreadContext,
    }
  })
