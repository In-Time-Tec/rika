import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product/usage-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as UsageProjection from "../../usage/usage-projection"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import { persistedThreadUsage } from "../interactive/interactive-session-transcript-runtime"
import { readThreadContext as readAuthoritativeThreadContext } from "../interactive/interactive-thread-context"
import type { Commit, Refold } from "../../execution/ingest/execution-ingest-commit"
import { Cause, Effect, FiberSet, Queue, Result, Scope } from "effect"
import { failureKind, operationError, OperationError } from "../operation-error"
import type { InteractiveEvent } from "../interactive/interactive-event"
import type { InteractiveDependencyContext } from "../interactive/interactive-session-runtime"
import { applyGeneratedTitle } from "./product-operation-ingest-title"

const undeliveredEventsImpl = (
  events: ReadonlyArray<ExecutionEvent.Event>,
  delivered: ReadonlySet<string>,
): ReadonlyArray<ExecutionEvent.Event> =>
  events.filter((event) => !delivered.has(event.cursor)).toSorted((left, right) => left.sequence - right.sequence)

export const undeliveredEvents: {
  (arg1: ReadonlySet<string>): (arg0: ReadonlyArray<ExecutionEvent.Event>) => ReturnType<typeof undeliveredEventsImpl>
  (arg0: ReadonlyArray<ExecutionEvent.Event>, arg1: ReadonlySet<string>): ReturnType<typeof undeliveredEventsImpl>
} = Function.dual(2, undeliveredEventsImpl)

export interface ProductOperationIngest {
  readonly executionIngest: ExecutionIngest.Interface
  readonly ensureIngest: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never>
  readonly awaitIngestSettled: (turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never>
  readonly flushIngest: (turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never>
  readonly deliverResultEvents: (
    turnId: Turn.TurnId,
    events: ReadonlyArray<ExecutionEvent.Event>,
    delivered?: ReadonlySet<string>,
  ) => void
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

export interface ProductOperationIngestInput {
  readonly acquiredBackend: import("@rika/product/execution-gateway").Interface
  readonly usageRepository: UsageRepository.Interface
  readonly ownerScope: Scope.Scope
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly ingestFailureMessage: string
  readonly transcripts: TranscriptRepository.Interface
  readonly turns: TurnRepository.Interface
  readonly dependencyContext: InteractiveDependencyContext
}

export const makeProductOperationIngest = (
  input: ProductOperationIngestInput,
): Effect.Effect<ProductOperationIngest, Error, never> =>
  Effect.gen(function* () {
    const {
      acquiredBackend: rawBackend,
      usageRepository: rawUsageRepository,
      ownerScope: rawOwnerScope,
      publishInteractiveActivity,
      ingestFailureMessage,
    } = input
    const ownerScope: Scope.Scope = rawOwnerScope
    const acquiredBackend: import("@rika/product/execution-gateway").Interface = rawBackend
    const usageRepository: UsageRepository.Interface = rawUsageRepository
    const turns: TurnRepository.Interface = input.turns
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
      onFailure: (failure) =>
        publishInteractiveActivity(0, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          ...(failure.threadId === undefined ? {} : { threadId: Thread.ThreadId.make(failure.threadId) }),
          ...(failure.turnId === undefined ? {} : { turnId: Turn.TurnId.make(failure.turnId) }),
          message: ingestFailureMessage,
        }),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope))
    const fork = yield* FiberSet.makeRuntime<never, void, never>().pipe(Effect.provideService(Scope.Scope, ownerScope))
    const productIngest: ExecutionIngest.Interface = {
      ...executionIngest,
      deliver: (turnId, event) => {
        applyGeneratedTitle(
          { turns, dependencyContext: input.dependencyContext, publishInteractiveActivity, fork },
          turnId,
          event,
        )
        executionIngest.deliver(turnId, event)
      },
    }
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const commit = yield* Queue.take(usageCommits)
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
    const ensureIngest = (threadId: Thread.ThreadId, turnId: Turn.TurnId) =>
      executionIngest
        .ensure({ threadId, turnId })
        .pipe(Effect.mapError((failure) => operationError(failure.message, failure)))
    const awaitIngestSettled = (turnId: Turn.TurnId) =>
      executionIngest.settled(turnId).pipe(Effect.mapError((failure) => operationError(failure.message, failure)))
    const flushIngest = (turnId: Turn.TurnId) =>
      executionIngest.flush(turnId).pipe(Effect.mapError((failure) => operationError(failure.message, failure)))
    const deliverResultEvents = (
      turnId: Turn.TurnId,
      events: ReadonlyArray<ExecutionEvent.Event>,
      delivered: ReadonlySet<string> = new Set(),
    ) => {
      for (const event of undeliveredEvents(events, delivered)) productIngest.deliver(turnId, event)
    }
    return {
      executionIngest: productIngest,
      ensureIngest,
      awaitIngestSettled,
      flushIngest,
      deliverResultEvents,
      commitUsageSource,
      publishThreadUsage,
      readThreadContext,
    }
  })
