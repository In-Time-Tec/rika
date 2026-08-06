import { ModelRegistry, SandboxExecutor } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { reviewIntent } from "@rika/product/review-policy"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { layer } from "../src/baton-execution"

const fanOutJoin = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

const sandbox = SandboxExecutor.makeTest(() => Effect.die(new Error("unexpected Program execution")), {
  language: "javascript",
  implementation: "rika-review-test-sandbox",
  version: "1",
  memoryBytes: 1024,
  stackBytes: 1024,
})

const testLayer = (filename: string, fixture: TestModel.Fixture) =>
  layer({
    filename,
    modelServices: ModelRegistry.layer([
      Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false }),
    ]),
  }).pipe(Layer.provide(Layer.succeed(SandboxExecutor.SandboxExecutor, sandbox)))

const input = (route: ReturnType<typeof testExecutionRoute>) => ({
  threadId: "review-thread",
  turnId: "review-turn",
  workspace: "/workspace",
  prompt: "Review the production change",
  executionRoute: route,
  reviewIntent: reviewIntent("Review the production change"),
})

it.live(
  "admits and recovers one ordered SQLite review fan-out without product review state",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-review-${randomUUID()}.db`
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
          return { link, duplicate, events: [...events] }
        }),
      )
      const database = new Database(filename)
      const fanOut = database
        .query<
          {
            parent_run_id: string
            idempotency_key: string
            join_json: string
            remainder: string
            concurrency: number
            status: string
          },
          []
        >("SELECT parent_run_id, idempotency_key, join_json, remainder, concurrency, status FROM baton_fan_outs")
        .get()!
      const members = database
        .query<
          { ordinal: number; member_key: string; child_run_id: string; status: string },
          []
        >("SELECT ordinal, member_key, child_run_id, status FROM baton_fan_out_members ORDER BY ordinal")
        .all()
      const reviewTables = database
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%review%'")
        .all()
      database.close()
      const reopened = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(testLayer(filename, fixture))
          return yield* Context.get(context, ExecutionGateway.Service).startTurn(input(route))
        }),
      )

      expect(first.duplicate).toEqual(first.link)
      expect(reopened).toEqual(first.link)
      expect(fanOut).toMatchObject({
        parent_run_id: first.link.runId,
        idempotency_key: "review-turn:review",
        remainder: "await",
        concurrency: 3,
        status: "succeeded",
      })
      expect(fanOutJoin(fanOut.join_json)).toEqual({ _tag: "AllSettled" })
      expect(members.map(({ ordinal, member_key, status }) => ({ ordinal, member_key, status }))).toEqual([
        { ordinal: 0, member_key: "correctness", status: "succeeded" },
        { ordinal: 1, member_key: "security", status: "succeeded" },
        { ordinal: 2, member_key: "quality", status: "succeeded" },
      ])
      expect(new Set(members.map(({ child_run_id }) => child_run_id)).size).toBe(3)
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
      expect(reviewTables).toEqual([])
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(testLayer(filename, fixture))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn(input(testExecutionRoute()))
          yield* gateway.cancelTurn(link, "stop review")
        }),
      )
      const database = new Database(filename)
      const runs = database
        .query<{ run_id: string; status: string }, []>("SELECT run_id, status FROM baton_runs ORDER BY run_id")
        .all()
      const members = database
        .query<{ status: string }, []>("SELECT status FROM baton_fan_out_members ORDER BY ordinal")
        .all()
      database.close()
      expect(runs).toHaveLength(4)
      expect(members).toHaveLength(3)
      expect(members.every(({ status }) => status === "running" || status === "cancelled")).toBe(true)
      expect(["cancelling", "cancelled"]).toContain(runs.find(({ run_id }) => run_id.startsWith("run_"))?.status)
    }),
  60_000,
)
