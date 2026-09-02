import { ModelRegistry, Response as AiResponse } from "generalist"
import { Runtime } from "generalist/runtime"
import { TestModel } from "generalist/test"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { Context, Effect, Inspectable, Layer, Logger, Metric, Stream } from "effect"
import { RuntimeProjection } from "../../src/engine/runtime-projection"
import { memoryLayer } from "../support/adapters"

it.live("projects provider-reported output usage beside the matching live preview", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* TestModel.make(
        [
          TestModel.turn([TestModel.reasoning("reasoning"), TestModel.text("answer")], {
            usage: AiResponse.Usage.make({
              inputTokens: { total: 13, uncached: 13, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 12, text: 5, reasoning: 7 },
            }),
          }),
        ],
        { provider: "test", model: "test", registrationKey: "test" },
      )
      const context = yield* Layer.build(
        memoryLayer({
          modelServices: ModelRegistry.layer([
            Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false }),
          ]),
        }),
      )
      const gateway = Context.get(context, ExecutionGateway.Service)
      const link = yield* gateway.startTurn({
        threadId: "preview-usage-thread",
        turnId: "preview-usage-turn",
        workspaceId: "/workspace",
        prompt: "count this output",
        executionRoute: testExecutionRoute(),
      })
      const events = [...(yield* gateway.watchTurn(link, { prompt: "count this output" }).pipe(Stream.runCollect))]
      const usage = events.find((event) => event._tag === "ModelPreviewUsage")
      const preview = events.find((event) => event._tag === "ModelPreview")
      const usageIndex = events.findIndex((event) => event._tag === "ModelPreviewUsage")
      const responseIndex = events.findIndex(
        (event) =>
          (event._tag === "ProjectionSnapshot" || event._tag === "ProjectionPatch") &&
          (event._tag === "ProjectionSnapshot" ? event.units : event.upsert).some(
            (unit) => unit.modelResponseId !== undefined,
          ),
      )

      expect(usage).toMatchObject({
        _tag: "ModelPreviewUsage",
        runId: link.runId,
        turn: 0,
        outputTokens: { total: 12, text: 5, reasoning: 7 },
      })
      expect(usage).toMatchObject({
        modelCallId: preview?.modelCallId,
        modelAttemptId: preview?.modelAttemptId,
        attempt: preview?.attempt,
      })
      expect(usageIndex).toBeGreaterThanOrEqual(0)
      expect(usageIndex).toBeGreaterThan(responseIndex)

      const changes = events.filter((event) => event._tag === "ProjectionSnapshot" || event._tag === "ProjectionPatch")
      const final = changes.at(-1)
      if (final === undefined || final.checkpoint === undefined)
        return yield* Effect.die("Projection did not checkpoint")
      const materialized = new Map<string, Unit>()
      for (const change of changes) {
        if (change._tag === "ProjectionSnapshot") {
          materialized.clear()
          for (const unit of change.units) materialized.set(unit.key, unit)
        } else {
          for (const key of change.remove) materialized.delete(key)
          for (const unit of change.upsert) materialized.set(unit.key, unit)
        }
      }
      const reconnected = [
        ...(yield* gateway
          .watchTurn(link, {
            prompt: "count this output",
            checkpoint: final.checkpoint,
          })
          .pipe(Stream.runCollect)),
      ]
      const rebuilt = reconnected.find((event) => event._tag === "ProjectionSnapshot")
      expect(rebuilt).toMatchObject({
        _tag: "ProjectionSnapshot",
        checkpoint: { cursor: final.checkpoint.cursor },
        state: final.state,
      })
      if (rebuilt?._tag === "ProjectionSnapshot") {
        expect(new Map(rebuilt.units.map((unit) => [unit.key, unit]))).toEqual(materialized)
        expect(rebuilt.state.usage.tokens?.total).toBe(25)
      }
    }),
  ),
)

const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.map(Logger.formatStructured, (record) => logs.push(record))
  return Effect.as(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
    logs,
  )
}

const modelRecords = (logs: ReadonlyArray<unknown>) =>
  logs.filter((record) => Inspectable.toStringUnknown(record).includes("hosted.model_")).length

it.live("observes hosted model telemetry once and never re-emits it from replayed history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("answer")])], {
        provider: "test",
        model: "test",
        registrationKey: "test",
      })
      const context = yield* Layer.build(
        memoryLayer({
          modelServices: ModelRegistry.layer([
            Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false }),
          ]),
        }),
      )
      const gateway = Context.get(context, ExecutionGateway.Service)
      const runtime = Context.get(context, Runtime.Runtime)
      const link = yield* gateway.startTurn({
        threadId: "telemetry-replay-thread",
        turnId: "telemetry-replay-turn",
        workspaceId: "/workspace",
        prompt: "answer once",
        executionRoute: testExecutionRoute(),
      })
      const watch = (input: Parameters<ExecutionGateway.Interface["watchTurn"]>[1]) =>
        RuntimeProjection.watchTurn(runtime, true, link, input).pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        )

      const live = yield* capture(watch({ prompt: "answer once" }))
      expect(modelRecords(live)).toBe(2)

      const events = yield* watch({ prompt: "answer once" })
      const final = events.findLast((event) => event._tag === "ProjectionSnapshot" || event._tag === "ProjectionPatch")
      if (final === undefined || final.checkpoint === undefined)
        return yield* Effect.die("Projection did not checkpoint")

      const fromScratch = yield* capture(watch({ prompt: "answer once" }))
      const fromCheckpoint = yield* capture(watch({ prompt: "answer once", checkpoint: final.checkpoint }))
      expect(modelRecords(fromScratch)).toBe(0)
      expect(modelRecords(fromCheckpoint)).toBe(0)
    }),
  ),
)
