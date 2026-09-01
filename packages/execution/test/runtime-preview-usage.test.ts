import { ModelRegistry, Response as AiResponse } from "generalist"
import { TestModel } from "generalist/test"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Stream } from "effect"
import { memoryLayer } from "./support/adapters"

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
          dataRoot: `/tmp/rika-preview-usage-${randomUUID()}.db`,
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
      const events = [...(yield* gateway.watchTurn(link).pipe(Stream.runCollect))]
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
    }),
  ),
)
