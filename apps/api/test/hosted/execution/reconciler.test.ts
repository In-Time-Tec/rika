import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Deferred, Effect, Layer } from "effect"
import {
  HostedExecutionReconciler,
  layer as hostedExecutionReconcilerLayer,
} from "../../../src/hosted/execution/reconciler"
import { layerTest as hostedWorkerRuntimeLayerTest } from "../../../src/hosted/worker-runtime"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt: "work",
  executionRoute: ExecutionRoute.testExecutionRoute(),
  executionLink: { runId: "run", threadId, turnId },
  status: "running",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}

it.effect("persists terminal execution state independently of transcript projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settled = yield* Deferred.make<Turn.AgentExecutionTurn>()
      let current: Turn.AgentExecutionTurn = turn
      const turns = Layer.mock(TurnRepository.Service, {
        listNonterminal: Effect.sync(() => (current.status === "running" ? [current] : [])),
        listSteeringAdmissions: Effect.succeed([]),
        setStatus: (_id: Turn.TurnId, status: Parameters<TurnRepository.Interface["setStatus"]>[1], now: number) =>
          Effect.sync(() => {
            current = { ...current, status, updatedAt: now }
            return current
          }).pipe(Effect.tap((updated) => Deferred.succeed(settled, updated))),
      })
      const transcriptRepository = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer()),
        TranscriptRepository.Service,
      )
      const transcripts = TranscriptRepository.Service.of({
        ...transcriptRepository,
        get: () => Effect.die("terminal reconciliation read transcript projection"),
        replaceUnits: () => Effect.die("terminal reconciliation wrote transcript projection"),
      })
      const gateway = ExecutionGateway.makeTest({
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "terminal" }),
      })
      const context = yield* Layer.build(
        hostedExecutionReconcilerLayer({
          fallbackIntervalMillis: 10,
        }).pipe(
          Layer.provide(hostedWorkerRuntimeLayerTest),
          Layer.provide(turns),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
      )

      expect(yield* Deferred.await(settled)).toMatchObject({ status: "completed" })
      yield* Effect.yieldNow
      yield* Context.get(context, HostedExecutionReconciler).ready
    }),
  ),
)
