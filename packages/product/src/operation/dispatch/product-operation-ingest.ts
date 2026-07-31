import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { Cause, Effect, Queue } from "effect"
import { failureKind, operationError } from "../operation-error"
import { undeliveredEvents } from "./execution-operation-coordination"

export const makeProductOperationIngest = (input: any) =>
  Effect.gen(function* () {
    const {
      acquiredBackend,
      usageRepository,
      ownerScope,
      publishInteractiveActivity,
      titleExecutionId,
      commitUsageSource,
      isTerminalStatus,
      ingestFailureMessage,
    } = input
    const usageCommits = yield* Queue.unbounded<ExecutionIngest.Commit>()
    const refoldingRoots = new Map<string, number>()
    const executionIngest = yield* ExecutionIngest.make({
      backend: acquiredBackend,
      transcripts: input.transcripts,
      turns: input.turns,
      usage: usageRepository,
      onCommitted: (commit) => Queue.offerUnsafe(usageCommits, commit),
      onRefold: (refold: ExecutionIngest.Refold) => {
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
    })
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const commit = yield* Queue.take(usageCommits)
          if (commit.refolded) {
            const sourceId = titleExecutionId(commit.rootTurnId)
            const inspection = yield* acquiredBackend.inspect(sourceId, ExecutionBackend.executionReference)
            if (inspection !== undefined) {
              if (!isTerminalStatus(inspection.status))
                return yield* operationError(`Title usage source ${sourceId} is nonterminal after root refold`)
              const replay = yield* acquiredBackend.replay(sourceId, undefined, ExecutionBackend.executionReference)
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
            yield* usageRepository.readTurn(String(commit.rootTurnId)).pipe(Effect.flatMap(input.publishThreadUsage))
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
        .pipe(Effect.mapError((failure: any) => operationError(failure.message)))
    const awaitIngestSettled = (turnId: any) =>
      executionIngest.settled(turnId).pipe(Effect.mapError((failure: any) => operationError(failure.message)))
    const flushIngest = (turnId: any) =>
      executionIngest.flush(turnId).pipe(Effect.mapError((failure: any) => operationError(failure.message)))
    const deliverResultEvents = (
      turnId: any,
      events: ReadonlyArray<ExecutionBackend.Event>,
      delivered: ReadonlySet<string> = new Set(),
    ) => {
      for (const event of undeliveredEvents(events, delivered)) executionIngest.deliver(turnId, event)
    }
    return { executionIngest, ensureIngest, awaitIngestSettled, flushIngest, deliverResultEvents }
  })
