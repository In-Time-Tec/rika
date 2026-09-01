import { ModelRegistry } from "generalist"
import { TestModel } from "generalist/test"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { Change } from "@rika/product/execution-projection"
import { reviewIntent } from "@rika/product/review-policy"
import { RunTree, Runtime } from "generalist/runtime"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Stream } from "effect"
import { memoryLayer as layer } from "../support/adapters"

const projectionChanges = (events: ReadonlyArray<ExecutionGateway.ModelPreviewEvent | Change>): ReadonlyArray<Change> =>
  events.filter(
    (event): event is Change =>
      event._tag !== "ModelPreview" && event._tag !== "ModelPreviewUsage" && event._tag !== "ModelPreviewCleared",
  )

const testLayer = (filename: string, fixture: TestModel.Fixture) =>
  layer({
    modelServices: ModelRegistry.layer([
      Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false }),
    ]),
  })

const input = (route: ReturnType<typeof testExecutionRoute>) => ({
  threadId: "review-thread",
  turnId: "review-turn",
  workspaceId: "/workspace",
  prompt: "Review the production change",
  executionRoute: route,
  reviewIntent: reviewIntent("Review the production change"),
})

it.live(
  "admits one ordered in-memory review fan-out without product review state",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-review-${randomUUID()}`
      const fixture = yield* TestModel.make(
        Array.from({ length: 4 }, () => TestModel.turn([TestModel.text("reviewed")])),
        { provider: "test", model: "test", registrationKey: "test" },
      )
      const route = testExecutionRoute()
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(testLayer(filename, fixture))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn(input(route))
          const duplicate = yield* gateway.startTurn(input(route))
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          return { link, duplicate, events: projectionChanges([...events]) }
        }),
      )

      expect(first.duplicate).toEqual(first.link)
      const reviewCards = first.events.flatMap((change) =>
        (change._tag === "ProjectionSnapshot" ? change.units : change.upsert).filter(
          (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
        ),
      )
      expect(new Set(reviewCards.map((unit) => unit.key)).size).toBe(3)
      expect(
        new Set(
          reviewCards.flatMap((unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "SubagentCard" &&
            unit.content.block.status === "complete"
              ? [unit.key]
              : [],
          ),
        ).size,
      ).toBe(3)
      expect(yield* fixture.requests).toHaveLength(4)
    }),
  120_000,
)

it.live(
  "requests cancellation for the review root and admitted lanes",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-review-cancel-${randomUUID()}.db`
      const fixture = yield* TestModel.make(
        Array.from({ length: 4 }, () => TestModel.turn([TestModel.text("late")], { delay: 5_000 })),
        { provider: "test", model: "test", registrationKey: "test" },
      )
      const cancelled = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(testLayer(filename, fixture))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const runtime = Context.get(context, Runtime.Runtime)
          const link = yield* gateway.startTurn(input(testExecutionRoute()))
          yield* gateway.cancelTurn(link, "stop review")
          const checkpoint = yield* RunTree.checkpoint(link.runId).pipe(Effect.provideService(Runtime.Runtime, runtime))
          return {
            tree: checkpoint.inspection,
          }
        }),
      )
      const runs = cancelled.tree.runs.map(({ run }) => run)
      expect(runs).toHaveLength(4)
      expect(["cancelling", "cancelled"]).toContain(runs.find(({ depth }) => depth === 0)?.status)
    }),
  60_000,
)
