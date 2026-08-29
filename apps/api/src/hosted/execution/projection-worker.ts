import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionProjectionWatch from "@rika/product/execution-projection-watch"
import { ThreadId as HostedThreadId } from "@rika/product/hosted-model"
import * as HostedObservability from "@rika/product/hosted-observability"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type { ProjectionRecoveryCandidate } from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Effect, Layer, Schema } from "effect"
import { HostedPreviewBus } from "../thread/previews"
import { HostedThreadApplication } from "../thread/application"
import { HostedWorkerRuntime, type HostedWorkerStatus } from "../worker-runtime"

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

export type HostedProjectionWorkerStatus = HostedWorkerStatus

export const layer = (options: { readonly concurrency: number; readonly fallbackIntervalMillis: number }) =>
  Layer.effect(
    HostedProjectionWorker,
    Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const backend = yield* ExecutionGateway.Service
      const previews = yield* HostedPreviewBus
      const operations = yield* HostedThreadApplication
      const runtime = yield* HostedWorkerRuntime
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
            onCommitted: () =>
              operations
                .projectionCommitted(candidate.threadId)
                .pipe(
                  Effect.mapError((error) => TranscriptRepository.RepositoryError.make({ message: error.message })),
                ),
          }).pipe(Effect.asVoid),
        ).pipe(
          Effect.annotateLogs({
            "rika.turn.id": String(candidate.turnId),
          }),
        )
      const worker = yield* runtime.register({
        domain: "projection",
        concurrency: options.concurrency,
        fallbackIntervalMillis: options.fallbackIntervalMillis,
        scanFailureMessage: "Projection worker scan failed",
        executionFailureMessage: "Projection worker failed",
        scan: (control) =>
          Effect.gen(function* () {
            const candidates = yield* transcripts.listProjectionRecoveryCandidates(
              ExecutionProjection.projectionVersion,
            )
            let started = 0
            let oldestRunnableAt: number | undefined
            for (const candidate of candidates) {
              const key = String(candidate.turnId)
              if (yield* control.isActive(key)) continue
              if (
                started < control.availableCapacity &&
                (yield* control.start({
                  key,
                  runnableAt: candidate.createdAt,
                  effect: project(candidate),
                }))
              ) {
                started += 1
                continue
              }
              oldestRunnableAt =
                oldestRunnableAt === undefined ? candidate.createdAt : Math.min(oldestRunnableAt, candidate.createdAt)
            }
            return { oldestRunnableAt }
          }),
      })
      return HostedProjectionWorker.of({
        status: worker.status,
        ready: worker.ready.pipe(
          Effect.mapError((error) => HostedProjectionWorkerError.make({ message: error.message })),
        ),
      })
    }),
  )
