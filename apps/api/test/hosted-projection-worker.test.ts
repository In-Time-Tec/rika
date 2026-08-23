import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Deferred, Effect, Layer, Stream } from "effect"
import { HostedProjectionWorker, layer as hostedProjectionWorkerLayer } from "../src/hosted-projection-worker"

const threadId = Thread.ThreadId.make("thread-test")
const turnId = Turn.TurnId.make("turn-test")
const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt: "test",
  executionRoute: ExecutionRoute.testExecutionRoute(),
  executionLink: { runId: "run-test", threadId, turnId },
  status: "running",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}

const state = (status: "running" | "completed") => ({
  status,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

it.effect("projects a recovered Turn through its terminal cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settled = yield* Deferred.make<Turn.AgentExecutionTurn>()
      let projection: Projection | undefined
      const turns = {
        get: () => Effect.succeed(turn),
        setStatus: (_id: Turn.TurnId, status: ExecutionProjection.Result["status"], now: number) => {
          const updated = { ...turn, status, updatedAt: now }
          return Deferred.succeed(settled, updated).pipe(Effect.as(updated))
        },
      } as unknown as TurnRepository.Interface
      const transcripts = {
        listProjectionRecoveryCandidates: () => Effect.succeed([{ threadId, turnId }]),
        get: () => Effect.succeed(projection),
        commitProjection: (_turn: Turn.AgentExecutionTurn, change: ExecutionProjection.Change) =>
          Effect.sync(() => {
            projection = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (projection?.units ?? []),
              checkpointGeneration: (projection?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      } as unknown as TranscriptRepository.Interface
      const running: ExecutionProjection.Change = {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
        units: [],
        hasOlder: false,
        state: state("running"),
      }
      const completed: ExecutionProjection.Change = {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed", state: "{}" },
        upsert: [],
        remove: [],
        state: state("completed"),
      }
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        watchTurn: () => Stream.fromIterable([running, completed]),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "completed" }),
      })
      const context = yield* Layer.build(
        hostedProjectionWorkerLayer({ concurrency: 2, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(TurnRepository.Service, turns)),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
      )
      expect(yield* Deferred.await(settled)).toMatchObject({ status: "completed" })
      yield* HostedProjectionWorker.pipe(
        Effect.provide(context),
        Effect.flatMap((worker) => worker.ready),
      )
      expect(projection).toMatchObject({
        revision: 1,
        state: { status: "completed" },
        projectorCheckpoint: { cursor: "completed" },
      })
    }),
  ),
)
