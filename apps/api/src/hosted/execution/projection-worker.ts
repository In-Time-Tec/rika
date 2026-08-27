import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionProjectionWatch from "@rika/product/execution-projection-watch"
import { ThreadId as HostedThreadId } from "@rika/product/hosted-model"
import * as HostedObservability from "@rika/product/hosted-observability"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type { ProjectionRecoveryCandidate } from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Clock, Context, Effect, FiberMap, Layer, Ref, Schema, SubscriptionRef } from "effect"
import { HostedPreviewBus } from "../thread/previews"

export class HostedProjectionWorkerError extends Schema.TaggedError<HostedProjectionWorkerError>()(
  "HostedProjectionWorkerError",
  { message: Schema.String },
) {}

export interface HostedProjectionWorkerService {
  readonly ready: Effect.Effect<void, HostedProjectionWorkerError>
  readonly status: Effect.Effect<HostedProjectionWorkerStatus>
}

export class HostedProjectionWorker extends Context.Service<HostedProjectionWorker, HostedProjectionWorkerService>()(
  "@rika/api/hosted/execution/projection-worker/HostedProjectionWorker",
) {}

type PollStatus =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Succeeded"; readonly at: number }
  | { readonly _tag: "Failed"; readonly at: number; readonly message: string }

interface WorkerState {
  readonly poll: PollStatus
  readonly lastSuccessfulPollAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
}

export interface HostedProjectionWorkerStatus extends WorkerState {
  readonly active: number
  readonly capacity: number
  readonly availableCapacity: number
  readonly oldestActiveProjectionAt: number | undefined
  readonly pollAgeMillis: number | undefined
  readonly lastSuccessfulPollAgeMillis: number | undefined
  readonly oldestActiveProjectionAgeMillis: number | undefined
  readonly lastFailureAgeMillis: number | undefined
}

const age = (now: number, at: number | undefined) => (at === undefined ? undefined : now - at)

export const layer = (options: { readonly concurrency: number; readonly pollIntervalMillis: number }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const backend = yield* ExecutionGateway.Service
      const previews = yield* HostedPreviewBus
      const health = yield* SubscriptionRef.make<WorkerState>({
        poll: { _tag: "Starting" },
        lastSuccessfulPollAt: undefined,
        lastFailure: undefined,
      })
      const active = yield* FiberMap.make<string>()
      const activeProjections = yield* Ref.make<
        ReadonlyMap<string, { readonly token: symbol; readonly startedAt: number }>
      >(new Map())
      const project = (candidate: ProjectionRecoveryCandidate) =>
        HostedObservability.observe(
          "attach",
          { turnId: candidate.turnId },
          ExecutionProjectionWatch.watch({
            turnId: candidate.turnId,
            turns,
            transcripts,
            backend,
            onPreview: (preview) =>
              previews.publish({
                threadId: HostedThreadId.make(candidate.threadId),
                turnId: candidate.turnId,
                preview,
              }),
          }).pipe(Effect.asVoid),
        ).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            const message = "Hosted projection worker failed"
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((at) =>
                SubscriptionRef.update(health, (state) => ({ ...state, lastFailure: { at, message } })),
              ),
              Effect.andThen(
                Effect.logError("hosted-projection-worker.failed").pipe(
                  Effect.annotateLogs({
                    "rika.turn.id": String(candidate.turnId),
                  }),
                ),
              ),
            )
          }),
        )
      const poll = Effect.gen(function* () {
        const candidates = yield* transcripts.listProjectionRecoveryCandidates(ExecutionProjection.projectionVersion)
        for (const candidate of candidates) {
          if ((yield* FiberMap.size(active)) >= options.concurrency) break
          const key = String(candidate.turnId)
          if (yield* FiberMap.has(active, key)) continue
          const startedAt = yield* Clock.currentTimeMillis
          const token = Symbol()
          yield* Ref.update(activeProjections, (entries) => new Map(entries).set(key, { token, startedAt }))
          yield* FiberMap.run(
            active,
            key,
            project(candidate).pipe(
              Effect.ensuring(
                Ref.update(activeProjections, (entries) => {
                  if (entries.get(key)?.token !== token) return entries
                  const updated = new Map(entries)
                  updated.delete(key)
                  return updated
                }),
              ),
            ),
          )
        }
        const now = yield* Clock.currentTimeMillis
        yield* SubscriptionRef.update(health, (state) => ({
          ...state,
          poll: { _tag: "Succeeded", at: now } as const,
          lastSuccessfulPollAt: now,
        }))
        yield* Effect.sleep(options.pollIntervalMillis)
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const message = "Hosted projection worker poll failed"
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) =>
              SubscriptionRef.update(health, (state) => ({
                ...state,
                poll: { _tag: "Failed", at, message } as const,
                lastFailure: { at, message },
              })),
            ),
            Effect.andThen(Effect.logError("hosted-projection-worker.poll-failed")),
            Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
          )
        }),
      )
      const status: Effect.Effect<HostedProjectionWorkerStatus> = Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(health)
        const now = yield* Clock.currentTimeMillis
        const entries = yield* Ref.get(activeProjections)
        const activeCount = yield* FiberMap.size(active)
        const oldestActiveProjectionAt =
          entries.size === 0
            ? undefined
            : Math.min(...Array.from(entries.values(), (projection) => projection.startedAt))
        const pollAt = state.poll._tag === "Starting" ? undefined : state.poll.at
        return {
          ...state,
          active: activeCount,
          capacity: options.concurrency,
          availableCapacity: Math.max(0, options.concurrency - activeCount),
          oldestActiveProjectionAt,
          pollAgeMillis: age(now, pollAt),
          lastSuccessfulPollAgeMillis: age(now, state.lastSuccessfulPollAt),
          oldestActiveProjectionAgeMillis: age(now, oldestActiveProjectionAt),
          lastFailureAgeMillis: age(now, state.lastFailure?.at),
        }
      })
      const service = HostedProjectionWorker.of({
        status,
        ready: status.pipe(
          Effect.flatMap((state) => {
            if (state.poll._tag === "Starting")
              return Effect.fail(
                HostedProjectionWorkerError.make({
                  message: "Hosted projection worker has not completed its first poll",
                }),
              )
            if (state.poll._tag === "Failed")
              return Effect.fail(HostedProjectionWorkerError.make({ message: state.poll.message }))
            if (state.pollAgeMillis !== undefined && state.pollAgeMillis > options.pollIntervalMillis * 4)
              return Effect.fail(
                HostedProjectionWorkerError.make({ message: "Hosted projection worker poll is stale" }),
              )
            return Effect.void
          }),
        ),
      })
      return Layer.merge(
        Layer.succeed(HostedProjectionWorker, service),
        Layer.effectDiscard(Effect.forkScoped(Effect.forever(poll))),
      )
    }),
  )
