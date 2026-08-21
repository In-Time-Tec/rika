import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import type { Change } from "@rika/product/execution-projection"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { Runtime } from "tenetkit/runtime"
import { Context, Effect, Layer, Random, Schedule, Schema, Stream } from "effect"
import { sqliteLayer as layer } from "./test-adapters"
import { laneExecutionRoute, makeLaneModels, step as model, type LaneModels, type Profile } from "../src/test-harness"

const waitForRequests = (models: LaneModels, profile: Profile, count: number) =>
  models.requestCountFor(profile).pipe(
    Effect.filterOrFail(
      (current) => current >= count,
      () => "pending" as const,
    ),
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 4_000 }),
    Effect.asVoid,
  )

const projection = (events: ReadonlyArray<ExecutionGateway.WatchEvent>) => {
  const units = new Map<string, Unit>()
  let state: Change["state"] | undefined
  for (const event of events) {
    if (event._tag === "ModelPreview" || event._tag === "ModelPreviewCleared") continue
    state = event.state
    if (event._tag === "ProjectionSnapshot") {
      units.clear()
      for (const unit of event.units) units.set(unit.key, unit)
    } else {
      for (const key of event.remove) units.delete(key)
      for (const unit of event.upsert) units.set(unit.key, unit)
    }
  }
  return { units: [...units.values()], state }
}

const waitForRecursiveSuspension = (runtime: Runtime.Interface, rootRunId: string) =>
  runtime.inspectTree(rootRunId).pipe(
    Effect.filterOrFail(
      (inspection) => {
        const runs = inspection.runs.map(({ run }) => run).toSorted((left, right) => left.depth - right.depth)
        return (
          runs.find(({ depth }) => depth === 1)?.status === "waiting" &&
          runs.find(({ depth }) => depth === 2)?.status === "queued"
        )
      },
      () => "pending" as const,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 millis"), times: 5_000 }),
    Effect.asVoid,
  )

const watch = (filename: string, models: LaneModels, link: ExecutionGateway.ExecutionLink) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        layer({ filename, modelServices: models.registryLayer, scheduler: { concurrency: 1 } }),
      )
      const gateway = Context.get(context, ExecutionGateway.Service)
      yield* gateway.inspectTurn(link).pipe(
        Effect.filterOrFail(
          ({ status }) => status === "completed",
          () => "pending" as const,
        ),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 4_000 }),
      )
      return projection([...(yield* gateway.watchTurn(link).pipe(Stream.runCollect))])
    }),
  )

it.live(
  "reconstructs a blocked recursive Run and resumes it exactly once after SQLite runtime restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const filename = `/tmp/rika-tenetkit-recursive-recovery-${yield* Random.nextInt}.db`
        const grandchildResult = `GRANDCHILD_START:${"終🚀".repeat(7_000)}:GRANDCHILD_END`
        const childResult = `CHILD_START:${grandchildResult}:CHILD_END`
        const models = yield* makeLaneModels([
          {
            steps: [
              model.turn([
                model.spawn([{ profile: "Task", prompt: "RECOVER_CHILD", name: "Recovered child" }], "recover-child"),
              ]),
              model.text("RECOVERED_PARENT"),
            ],
          },
          {
            profile: "Task",
            steps: [
              model.turn([
                model.spawn(
                  [{ profile: "Oracle", prompt: "RECOVER_GRANDCHILD", name: "Recovered grandchild" }],
                  "recover-grandchild",
                ),
              ]),
              model.text(childResult),
            ],
          },
          { profile: "Oracle", steps: [model.text(grandchildResult)] },
        ])
        const route = { ...laneExecutionRoute(), subagents: { maxDepth: 2, maxSubagents: 4 } }
        const link = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              layer({ filename, modelServices: models.registryLayer, scheduler: { concurrency: 1 } }),
            )
            const gateway = Context.get(context, ExecutionGateway.Service)
            const runtime = Context.get(context, Runtime.Runtime)
            const admitted = yield* gateway.startTurn({
              threadId: "recursive-recovery-thread",
              turnId: "recursive-recovery-turn",
              workspaceId: "/workspace",
              prompt: "Recover recursive work",
              executionRoute: route,
            })
            yield* waitForRequests(models, "Task", 1)
            yield* waitForRecursiveSuspension(runtime, admitted.runId)
            return admitted
          }),
        )

        const recovered = yield* watch(filename, models, link)
        expect(recovered.state?.status).toBe("completed")
        expect(yield* models.requestCountFor("Root")).toBe(2)
        expect(yield* models.requestCountFor("Task")).toBe(2)
        expect(yield* models.requestCountFor("Oracle")).toBe(1)

        const rootRequests = yield* models.requestsFor("Root")
        const taskRequests = yield* models.requestsFor("Task")
        const oracleRequests = yield* models.requestsFor("Oracle")
        const rootRequest = rootRequests[1] ?? (yield* Effect.die("missing resumed root request"))
        const taskRequest = taskRequests[1] ?? (yield* Effect.die("missing resumed child request"))
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(rootRequest.prompt)).toContain(
          childResult,
        )
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(taskRequest.prompt)).toContain(
          grandchildResult,
        )
        expect(taskRequests[0]?.tools.map(({ name }) => name).toSorted()).toEqual([
          "run_child",
          "run_child_group",
          "typescript",
        ])
        expect(oracleRequests[0]?.tools.map(({ name }) => name)).toEqual(["typescript"])

        const restored = yield* watch(filename, models, link)
        const cards = restored.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard"
            ? [{ unit, card: unit.content.block }]
            : [],
        )
        const childCard = cards.find(({ card }) => card.name === "Recovered child")
        const grandchildCard = cards.find(({ card }) => card.name === "Recovered grandchild")
        expect(cards.map(({ card }) => ({ name: card.name, status: card.status }))).toEqual([
          { name: "Recovered child", status: "complete" },
          { name: "Recovered grandchild", status: "complete" },
        ])
        expect(childCard?.unit.parentId).toBeUndefined()
        expect(grandchildCard?.unit.parentId).toBe(childCard?.card.id)
        expect(
          restored.units.find((unit) => unit.content._tag === "Entry" && unit.content.text === grandchildResult)
            ?.parentId,
        ).toBe(grandchildCard?.card.id)
        expect(
          restored.units.find((unit) => unit.content._tag === "Entry" && unit.content.text === childResult)?.parentId,
        ).toBe(childCard?.card.id)
      }),
    ),
  60_000,
)
