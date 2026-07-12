import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { Operation, ProductAgent } from "../src/index"

const backend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: () => Effect.die("unused"),
  replay: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
  inspect: () => Effect.succeed(undefined),
  steer: () => Effect.die("unused"),
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.die("unused"),
  resolvePermission: () => Effect.die("unused"),
})

const input = (overrides: Partial<Extract<Operation.Input, { readonly _tag: "Review" }>> = {}) => ({
  _tag: "Review" as const,
  staged: false,
  ephemeral: false,
  json: false,
  paths: [],
  ...overrides,
})

const layer = (
  tool: ToolRuntime.Interface,
  agent: ProductAgent.Interface = ProductAgent.Service.of({
    invoke: () => Effect.die("unused"),
    fanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    runParallel: () => Effect.die("unused"),
    runReviewLanes: () => Effect.die("unused"),
    projectChildren: () => [],
    cancelChild: () => Effect.die("unused"),
  }),
) =>
  Layer.mergeAll(
    TestConsole.layer,
    Operation.productLayer({
      repositoryLayer: ThreadRepository.memoryLayer(),
      turnRepositoryLayer: TurnRepository.memoryLayer(),
      backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
      productAgentLayer: Layer.succeed(ProductAgent.Service, agent),
      toolRuntimeLayer: () => Layer.succeed(ToolRuntime.Service, tool),
      defaultWorkspace: "/work",
      makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
      makeTurnId: Effect.succeed(Turn.TurnId.make("review-turn")),
    }),
  )

describe("Operation review dispatcher", () => {
  it.effect("rejects review when no local tool runtime is configured", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(operation.run(input()))
      expect(error.message).toBe("Review requires the local tool runtime")
    }).pipe(
      Effect.provide(
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        }),
      ),
    ),
  )

  it.effect("builds staged and base git diffs and reports empty reviews in text and JSON", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<ToolRuntime.Request>>([])
      const tool = ToolRuntime.Service.of({
        run: (request) =>
          Ref.update(requests, (all) => [...all, request]).pipe(
            Effect.as({ text: "  ", truncated: false, exitCode: 0 }),
          ),
      })
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run(input({ staged: true, paths: ["src"] }))
        yield* operation.run(input({ base: "main", json: true }))
        return yield* TestConsole.logLines
      }).pipe(Effect.provide(layer(tool)))
      expect(yield* Ref.get(requests)).toMatchObject([
        { command: "git", args: ["diff", "--no-ext-diff", "--no-color", "--cached", "--", "src"] },
        { command: "git", args: ["diff", "--no-ext-diff", "--no-color", "main...HEAD"] },
      ])
      expect(output).toEqual(["No changes to review.", '{"status":"no-changes","findings":[]}'])
    }),
  )

  it.effect("maps timed out and failed git diff results to operation errors", () =>
    Effect.gen(function* () {
      for (const result of [
        { text: "", truncated: false },
        { text: "fatal diff", truncated: false, exitCode: 2 },
        { text: "", truncated: false, exitCode: 1 },
      ]) {
        const tool = ToolRuntime.Service.of({ run: () => Effect.succeed(result) })
        const error = yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          return yield* Effect.flip(operation.run(input()))
        }).pipe(Effect.provide(layer(tool)))
        expect(error.operation).toBe("Review")
      }
    }),
  )

  it.effect("runs review lanes and renders completed, failed, and structured lane output", () =>
    Effect.gen(function* () {
      const checks = yield* Ref.make<ReadonlyArray<ProductAgent.TaskInput>>([])
      const agent = ProductAgent.Service.of({
        invoke: () => Effect.die("unused"),
        fanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        runParallel: () => Effect.die("unused"),
        runReviewLanes: (request) =>
          Ref.set(checks, request.checks).pipe(
            Effect.as({
              fanOutId: request.fanOutId,
              parentTurnId: request.parentTurnId,
              state: "satisfied" as const,
              maxConcurrency: request.maxConcurrency,
              join: "best-effort" as const,
              members: [],
            }),
          ),
        projectChildren: (inspection) => [
          {
            ...inspection,
            childId: `${inspection.fanOutId}:correctness`,
            ordinal: 0,
            state: "completed",
            output: "ok",
          },
          { ...inspection, childId: `${inspection.fanOutId}:security`, ordinal: 1, state: "failed", error: "bad" },
          {
            ...inspection,
            childId: `${inspection.fanOutId}:quality`,
            ordinal: 2,
            state: "completed",
            output: { count: 1 },
          },
        ],
        cancelChild: () => Effect.die("unused"),
      })
      const tool = ToolRuntime.Service.of({
        run: () => Effect.succeed({ text: "diff --git a/a b/a", truncated: false, exitCode: 0 }),
      })
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run(input())
        yield* operation.run(input({ json: true }))
        return yield* TestConsole.logLines
      }).pipe(Effect.provide(layer(tool, agent)))
      expect(yield* Ref.get(checks)).toHaveLength(3)
      expect(output[0]).toContain("## correctness\nok")
      expect(output[0]).toContain("Review lane failed: bad")
      expect(output[0]).toContain('{"count":1}')
      expect(output[1]).toContain('"status":"satisfied"')
    }),
  )
})
