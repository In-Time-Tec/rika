import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { Operation, ProductAgent } from "../src/index"
import { provideLayer } from "./layer"
import { createTurn } from "./current-state"

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
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
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
  options: {
    readonly repositoryLayer?: Layer.Layer<ThreadRepository.Service>
    readonly turnRepositoryLayer?: Layer.Layer<TurnRepository.Service>
    readonly resolveExecutionRoute?: () => Effect.Effect<Turn.ExecutionRoutePin>
    readonly toolRuntimeLayer?: Layer.Layer<ToolRuntime.Service>
    readonly backend?: ExecutionBackend.Interface
  } = {},
) =>
  Layer.mergeAll(
    TestConsole.layer,
    Operation.productLayer({
      repositoryLayer: options.repositoryLayer ?? ThreadRepository.memoryLayer(),
      turnRepositoryLayer: options.turnRepositoryLayer ?? TurnRepository.memoryLayer(),
      backendLayer: Layer.succeed(ExecutionBackend.Service, options.backend ?? backend),
      productAgentLayer: Layer.succeed(ProductAgent.Service, agent),
      toolRuntimeLayer: () => options.toolRuntimeLayer ?? Layer.succeed(ToolRuntime.Service, tool),
      defaultWorkspace: "/work",
      makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
      makeTurnId: Effect.succeed(Turn.TurnId.make("review-turn")),
      ...(options.resolveExecutionRoute === undefined ? {} : { resolveExecutionRoute: options.resolveExecutionRoute }),
    }),
  )

describe("Operation review dispatcher", () => {
  it.effect("rejects review when no local tool runtime is configured", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(operation.run(input()))
      expect(error.message).toBe("Review requires the local tool runtime")
    }).pipe(
      provideLayer(
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
      }).pipe(provideLayer(layer(tool)))
      expect(yield* Ref.get(requests)).toMatchObject([
        { command: "git", args: ["diff", "--no-ext-diff", "--no-color", "--cached", "--", "src"] },
        { command: "git", args: ["diff", "--no-ext-diff", "--no-color", "main...HEAD"] },
      ])
      expect(output).toEqual(["No changes to review.", '{"status":"no-changes","findings":[]}'])
    }),
  )

  it.effect("releases the review runtime after each operation", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0)
      const releases = yield* Ref.make(0)
      const tool = ToolRuntime.Service.of({
        run: () => Effect.succeed({ text: "", truncated: false, exitCode: 0 }),
      })
      const toolRuntimeLayer = Layer.effect(
        ToolRuntime.Service,
        Effect.acquireRelease(Ref.update(acquisitions, (count) => count + 1).pipe(Effect.as(tool)), () =>
          Ref.update(releases, (count) => count + 1),
        ),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run(input())
        expect(yield* Ref.get(acquisitions)).toBe(1)
        expect(yield* Ref.get(releases)).toBe(1)
        yield* operation.run(input())
        expect(yield* Ref.get(acquisitions)).toBe(2)
        expect(yield* Ref.get(releases)).toBe(2)
      }).pipe(provideLayer(layer(tool, undefined, { toolRuntimeLayer })))
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
        }).pipe(provideLayer(layer(tool)))
        expect(error.operation).toBe("Review")
      }
    }),
  )

  it.effect("runs review lanes and renders completed, failed, and structured lane output", () =>
    Effect.gen(function* () {
      const capturedRequest = yield* Ref.make<Parameters<ProductAgent.Interface["runReviewLanes"]>[0] | undefined>(
        undefined,
      )
      const threads = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const route = Turn.testExecutionRoute("medium")
      const agent = ProductAgent.Service.of({
        invoke: () => Effect.die("unused"),
        fanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        runParallel: () => Effect.die("unused"),
        runReviewLanes: (request) =>
          Ref.set(capturedRequest, request).pipe(
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
        return yield* TestConsole.logLines
      }).pipe(
        provideLayer(
          layer(tool, agent, {
            repositoryLayer: Layer.succeed(ThreadRepository.Service, threads),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            resolveExecutionRoute: () => Effect.succeed(route),
          }),
        ),
      )
      const submitted = yield* Ref.get(capturedRequest)
      expect(submitted?.checks).toHaveLength(3)
      expect(submitted).toMatchObject({ workspace: "/work", executionRoute: route })
      expect((yield* turns.get(Turn.TurnId.make("review-turn")))?.executionRoute).toEqual(route)
      expect(yield* turns.get(Turn.TurnId.make("review-turn"))).toMatchObject({
        status: "completed",
        reviewFanOutId: "review:review-turn",
      })
      expect((yield* threads.get(Thread.ThreadId.make("thread")))?.workspace).toBe("/work")
      const rendered = output.find(
        (line): line is string => typeof line === "string" && line.includes("## correctness"),
      )
      expect(rendered).toContain("## correctness\nok")
      expect(rendered).toContain("Review lane failed: bad")
      expect(rendered).toContain('{"count":1}')
    }),
  )

  it.effect("marks the review owner failed when its foreground fan-out disappears", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.makeMemory()
      const created = yield* Deferred.make<void>()
      const agent = ProductAgent.Service.of({
        invoke: () => Effect.die("unused"),
        fanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        runParallel: () => Effect.die("unused"),
        runReviewLanes: (request) =>
          Deferred.succeed(created, undefined).pipe(
            Effect.as({
              fanOutId: request.fanOutId,
              parentTurnId: request.parentTurnId,
              state: "joining" as const,
              maxConcurrency: request.maxConcurrency,
              join: "best-effort" as const,
              members: [],
            }),
          ),
        projectChildren: () => [],
        cancelChild: () => Effect.die("unused"),
      })
      const missingBackend = ExecutionBackend.Service.of({
        ...backend,
        inspectFanOut: () => Effect.void.pipe(Effect.as(undefined)),
      })
      const tool = ToolRuntime.Service.of({
        run: () => Effect.succeed({ text: "diff --git a/a b/a", truncated: false, exitCode: 0 }),
      })
      const context = yield* Layer.build(
        Layer.mergeAll(
          TestConsole.layer,
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, missingBackend),
            productAgentLayer: Layer.succeed(ProductAgent.Service, agent),
            toolRuntimeLayer: () => Layer.succeed(ToolRuntime.Service, tool),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("review-turn")),
          }),
        ),
      )
      const operation = Context.get(context, Operation.Service)
      const error = yield* Effect.flip(operation.run(input()))
      expect(error.message).toContain("Review review:review-turn disappeared")
      expect((yield* turns.get(Turn.TurnId.make("review-turn")))?.status).toBe("failed")
    }).pipe(Effect.scoped),
  )

  it.effect("keeps an active review running while reconcile scans it", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.makeMemory()
      const scans = yield* Ref.make(0)
      const secondScan = yield* Deferred.make<void>()
      const countedTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Ref.updateAndGet(scans, (count) => count + 1).pipe(
          Effect.tap((count) => (count >= 2 ? Deferred.succeed(secondScan, undefined) : Effect.void)),
          Effect.andThen(turns.listNonterminal),
        ),
      })
      const reviewStarted = yield* Deferred.make<void>()
      const registerFanOut = yield* Deferred.make<void>()
      const fanOutRegistered = yield* Ref.make(false)
      const inspections = yield* Ref.make(0)
      const reviewInspection = (state: "joining" | "satisfied") => ({
        fanOutId: "review:review-turn",
        parentTurnId: Turn.TurnId.make("review-turn"),
        state,
        maxConcurrency: 3,
        join: "best-effort" as const,
        members: [],
      })
      const agent = ProductAgent.Service.of({
        invoke: () => Effect.die("unused"),
        fanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        runParallel: () => Effect.die("unused"),
        runReviewLanes: () =>
          Deferred.succeed(reviewStarted, undefined).pipe(
            Effect.andThen(Deferred.await(registerFanOut)),
            Effect.as(reviewInspection("joining")),
          ),
        projectChildren: (inspection) => [
          {
            ...inspection,
            childId: `${inspection.fanOutId}:correctness`,
            ordinal: 0,
            state: "completed",
            output: "ok",
          },
        ],
        cancelChild: () => Effect.die("unused"),
      })
      const reviewBackend = ExecutionBackend.Service.of({
        ...backend,
        inspectWorkflow: () => Effect.sync((): ExecutionBackend.WorkflowInspection | undefined => undefined),
        inspectFanOut: () =>
          Ref.update(inspections, (count) => count + 1).pipe(
            Effect.andThen(Ref.get(fanOutRegistered)),
            Effect.map((registered) => (registered ? reviewInspection("satisfied") : undefined)),
          ),
      })
      const tool = ToolRuntime.Service.of({
        run: () => Effect.succeed({ text: "diff --git a/a b/a", truncated: false, exitCode: 0 }),
      })
      const context = yield* Layer.build(
        layer(tool, agent, {
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, countedTurns),
          backend: reviewBackend,
        }),
      )
      const operation = Context.get(context, Operation.Service)
      const review = yield* Effect.forkChild(operation.run(input()))
      yield* Deferred.await(reviewStarted)

      yield* Effect.result(operation.run({ _tag: "Workflow", action: "inspect", runId: "missing" }))
      yield* Deferred.await(secondScan)
      yield* Effect.yieldNow

      expect(yield* turns.get(Turn.TurnId.make("review-turn"))).toMatchObject({ status: "running" })
      expect(yield* Ref.get(inspections)).toBe(0)

      yield* Ref.set(fanOutRegistered, true)
      yield* Deferred.succeed(registerFanOut, undefined)
      yield* Fiber.join(review)
      expect(yield* turns.get(Turn.TurnId.make("review-turn"))).toMatchObject({ status: "completed" })
    }).pipe(Effect.scoped),
  )

  it.effect("settles the review owner after the requesting operation is interrupted", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.makeMemory()
      const persisted = yield* Deferred.make<void>()
      const continueAdmission = yield* Deferred.make<void>()
      const created = yield* Deferred.make<void>()
      const fanOutState = yield* Ref.make<"joining" | "satisfied">("joining")
      const reviewTurns = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (submission) =>
          createTurn(turns, submission).pipe(
            Effect.tap(() => Deferred.succeed(persisted, undefined)),
            Effect.tap(() => Deferred.await(continueAdmission)),
          ),
      })
      const inspection = (state: "joining" | "satisfied") => ({
        fanOutId: "review:review-turn",
        parentTurnId: Turn.TurnId.make("review-turn"),
        state,
        maxConcurrency: 3,
        join: "best-effort" as const,
        members: [],
      })
      const agent = ProductAgent.Service.of({
        invoke: () => Effect.die("unused"),
        fanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        runParallel: () => Effect.die("unused"),
        runReviewLanes: () => Deferred.succeed(created, undefined).pipe(Effect.as(inspection("joining"))),
        projectChildren: () => [],
        cancelChild: () => Effect.die("unused"),
      })
      const residentBackend = ExecutionBackend.Service.of({
        ...backend,
        inspectFanOut: () => Ref.get(fanOutState).pipe(Effect.map(inspection)),
      })
      const tool = ToolRuntime.Service.of({
        run: () => Effect.succeed({ text: "diff --git a/a b/a", truncated: false, exitCode: 0 }),
      })
      const context = yield* Layer.build(
        Layer.mergeAll(
          TestConsole.layer,
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, reviewTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, residentBackend),
            productAgentLayer: Layer.succeed(ProductAgent.Service, agent),
            toolRuntimeLayer: () => Layer.succeed(ToolRuntime.Service, tool),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("review-turn")),
          }),
        ),
      )
      const operation = Context.get(context, Operation.Service)
      const request = yield* Effect.forkChild(operation.run(input()))
      yield* Deferred.await(persisted)
      const cancellation = yield* Effect.forkChild(Fiber.interrupt(request))
      yield* Deferred.succeed(continueAdmission, undefined)
      yield* Deferred.await(created)
      yield* Fiber.join(cancellation)
      expect((yield* turns.get(Turn.TurnId.make("review-turn")))?.status).toBe("running")
      yield* Ref.set(fanOutState, "satisfied")
      yield* TestClock.adjust("50 millis")
      while ((yield* turns.get(Turn.TurnId.make("review-turn")))?.status !== "completed")
        yield* Effect.sleep("10 millis")
      expect((yield* turns.get(Turn.TurnId.make("review-turn")))?.status).toBe("completed")
    }).pipe(Effect.scoped),
  )
})
