import { describe, expect, it } from "@effect/vitest"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Effect, Layer } from "effect"
import { ProductAgent, Workflow } from "../src"
import { provideLayer } from "./layer"

const failure = ExecutionBackend.BackendError.make({ message: "backend failed" })
const fanOut = (id: string, state: ExecutionBackend.FanOutInspection["state"]): ExecutionBackend.FanOutInspection => ({
  fanOutId: id,
  parentTurnId: "turn",
  state,
  maxConcurrency: 2,
  join: "all",
  members: [],
})
const workflow = (
  runId: string,
  status: ExecutionBackend.WorkflowInspection["status"],
): ExecutionBackend.WorkflowInspection => ({
  runId,
  workflow: "delivery",
  revision: 1,
  digest: "digest",
  status,
  createdAt: 1,
  updatedAt: 2,
})

const backend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" as const }),
  createFanOut: (input) => Effect.succeed(fanOut(input.fanOutId, "joining")),
  inspectFanOut: (id) => Effect.succeed(fanOut(id, "satisfied")),
  cancelFanOut: (id) => Effect.succeed(fanOut(id, "cancelled")),
  registerWorkflows: () => Effect.succeed([{ name: "delivery", revision: 1, digest: "digest" }]),
  startWorkflow: (_name, runId) => Effect.succeed(workflow(runId, "running")),
  inspectWorkflow: (runId) => Effect.succeed(workflow(runId, "completed")),
  cancelWorkflow: () => Effect.void.pipe(Effect.as(undefined)),
  start: () => Effect.die("unused"),
  replay: () => Effect.die("unused"),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.die("unused"),
  steer: () => Effect.die("unused"),
  listApprovals: () => Effect.die("unused"),
  resolveToolApproval: () => Effect.die("unused"),
  resolvePermission: () => Effect.die("unused"),
})

const layer = Layer.succeed(ExecutionBackend.Service, backend)
const failedLayer = Layer.succeed(
  ExecutionBackend.Service,
  ExecutionBackend.Service.of({
    ...backend,
    invokeChild: () => Effect.fail(failure),
    createFanOut: () => Effect.fail(failure),
    inspectFanOut: () => Effect.fail(failure),
    cancelFanOut: () => Effect.fail(failure),
    registerWorkflows: () => Effect.fail(failure),
    startWorkflow: () => Effect.fail(failure),
    inspectWorkflow: () => Effect.fail(failure),
    cancelWorkflow: () => Effect.fail(failure),
  }),
)

describe("ProductAgent and Workflow", () => {
  it.effect("delegates fan-out and workflow lifecycle operations", () =>
    Effect.gen(function* () {
      const agents = yield* ProductAgent.Service
      const input = {
        fanOutId: "fan",
        parentTurnId: "turn",
        children: [],
        maxConcurrency: 2,
        join: "all" as const,
        createdAt: 1,
      }
      expect((yield* agents.fanOut(input)).state).toBe("joining")
      expect((yield* agents.inspectFanOut("fan"))?.state).toBe("satisfied")
      expect((yield* agents.cancelFanOut("fan", 2, "stop")).state).toBe("cancelled")
      yield* agents.runParallel({
        ...input,
        tasks: [
          { id: "one", prompt: "research docs" },
          { id: "two", prompt: "x", profile: "Task" },
        ],
        quorum: 1,
      })
      yield* agents.runParallel({ ...input, tasks: [], join: "first-success" })
      yield* agents.runReviewLanes({ ...input, checks: [{ id: "review", prompt: "check" }], quorum: 1 })
      yield* agents.runReviewLanes({ ...input, checks: [] })
      expect(
        agents.projectChildren({
          ...fanOut("fan", "satisfied"),
          members: [
            { childId: "one", ordinal: 0, state: "completed", output: "ok" },
            { childId: "two", ordinal: 1, state: "failed", error: "no" },
          ],
        }),
      ).toHaveLength(2)
      expect((yield* agents.cancelChild("one", 3)).status).toBe("cancelled")
      const workflows = yield* Workflow.Service
      expect(yield* workflows.register).toEqual([{ name: "delivery", revision: 1, digest: "digest" }])
      expect((yield* workflows.start("delivery", "run", 2)).status).toBe("running")
      expect((yield* workflows.inspect("run"))?.status).toBe("completed")
      expect(yield* workflows.cancel("run")).toBeUndefined()
    }).pipe(provideLayer(Layer.merge(ProductAgent.layer, Workflow.layer).pipe(Layer.provide(layer)))),
  )

  it.effect("maps every backend failure to product errors", () =>
    Effect.gen(function* () {
      const agents = yield* ProductAgent.Service
      const workflows = yield* Workflow.Service
      const results = yield* Effect.all([
        Effect.flip(agents.invoke({ parentTurnId: "p", childId: "c", profile: "Task", prompt: "x" })),
        Effect.flip(
          agents.fanOut({
            fanOutId: "f",
            parentTurnId: "p",
            children: [],
            maxConcurrency: 1,
            join: "all",
            createdAt: 1,
          }),
        ),
        Effect.flip(agents.inspectFanOut("f")),
        Effect.flip(agents.cancelFanOut("f", 1)),
        Effect.flip(workflows.register),
        Effect.flip(workflows.start("delivery", "r")),
        Effect.flip(workflows.inspect("r")),
        Effect.flip(workflows.cancel("r")),
      ])
      expect(results.every((error) => error.message === "backend failed")).toBe(true)
    }).pipe(provideLayer(Layer.merge(ProductAgent.layer, Workflow.layer).pipe(Layer.provide(failedLayer)))),
  )

  it("selects all product profiles", () => {
    expect(
      ["review", "research", "documentation", "architecture", "investigate", "image", "visual", "thread", "other"].map(
        ProductAgent.selectProfile,
      ),
    ).toEqual(["Review", "Librarian", "Librarian", "Oracle", "Oracle", "Painter", "Painter", "ReadThread", "Task"])
  })
})
