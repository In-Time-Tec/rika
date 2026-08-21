import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionProjectionWatch from "@rika/product/execution-projection-watch"
import * as HostedObservability from "@rika/product/hosted-observability"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type { ProjectionRecoveryCandidate } from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Clock, Context, Effect, Layer, Ref, Schema } from "effect"

export class HostedProjectionWorkerError extends Schema.TaggedError<HostedProjectionWorkerError>()(
  "HostedProjectionWorkerError",
  { message: Schema.String },
) {}

export interface HostedProjectionWorkerService {
  readonly ready: Effect.Effect<void, HostedProjectionWorkerError>
}

export class HostedProjectionWorker extends Context.Service<HostedProjectionWorker, HostedProjectionWorkerService>()(
  "@rika/api/hosted-projection-worker/HostedProjectionWorker",
) {}

type Health =
  | { readonly _tag: "starting" }
  | { readonly _tag: "healthy" }
  | { readonly _tag: "failed"; readonly message: string }

export const layer = (options: { readonly concurrency: number; readonly pollIntervalMillis: number }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const backend = yield* ExecutionGateway.Service
      const health = yield* Ref.make<Health>({ _tag: "starting" })
      const active = yield* Ref.make<ReadonlySet<string>>(new Set())
      const forget = (turnId: string) =>
        Ref.update(active, (current) => {
          const next = new Set(current)
          next.delete(turnId)
          return next
        })
      const project = (candidate: ProjectionRecoveryCandidate) =>
        HostedObservability.observe(
          "projection_checkpoint",
          { turnId: candidate.turnId },
          ExecutionProjectionWatch.watch({ turnId: candidate.turnId, turns, transcripts, backend }).pipe(
            Effect.flatMap((result) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => turns.setStatus(candidate.turnId, result.status, now)),
              ),
            ),
            Effect.asVoid,
          ),
        ).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            const message = "Hosted projection worker failed"
            return Ref.set(health, { _tag: "failed", message }).pipe(
              Effect.andThen(
                Effect.logError("hosted-projection-worker.failed").pipe(
                  Effect.annotateLogs({
                    "rika.turn.id": String(candidate.turnId),
                  }),
                ),
              ),
            )
          }),
          Effect.ensuring(forget(String(candidate.turnId))),
        )
      const admit = (candidate: ProjectionRecoveryCandidate) =>
        Ref.modify(active, (current) => {
          const key = String(candidate.turnId)
          if (current.has(key) || current.size >= options.concurrency) return [false, current] as const
          const next = new Set(current)
          next.add(key)
          return [true, next] as const
        })
      const poll = Effect.gen(function* () {
        const candidates = yield* transcripts.listProjectionRecoveryCandidates(ExecutionProjection.projectionVersion)
        for (const candidate of candidates) {
          if (!(yield* admit(candidate))) continue
          yield* Effect.forkScoped(project(candidate))
        }
        yield* Ref.set(health, { _tag: "healthy" })
        yield* Effect.sleep(options.pollIntervalMillis)
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const message = "Hosted projection worker poll failed"
          return Ref.set(health, { _tag: "failed", message }).pipe(
            Effect.andThen(Effect.logError("hosted-projection-worker.poll-failed")),
            Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
          )
        }),
      )
      const service = HostedProjectionWorker.of({
        ready: Ref.get(health).pipe(
          Effect.flatMap((state) =>
            state._tag === "healthy"
              ? Effect.void
              : Effect.fail(
                  HostedProjectionWorkerError.make({
                    message:
                      state._tag === "starting"
                        ? "Hosted projection worker has not completed its first poll"
                        : state.message,
                  }),
                ),
          ),
        ),
      })
      return Layer.merge(
        Layer.succeed(HostedProjectionWorker, service),
        Layer.effectDiscard(Effect.forkScoped(Effect.forever(poll))),
      )
    }),
  )
