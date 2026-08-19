import { expect, it } from "@effect/vitest"
import { ToolContext, ToolExecutor } from "tenetkit"
import { Cell, CellTool, KernelProfile, TestKernel } from "tenetkit/repl"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer } from "effect"
import { Response } from "effect/unstable/ai"
import { configure } from "../src/baton-route"
import * as CellCallContext from "../src/baton-cell-call-context"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

const profile = KernelProfile.make({
  runtime: { name: "bun", version: kernel.runtimeVersion, digest: "runtime-digest" },
  bindingsDigest: KernelProfile.bindingsDigest(["workspace"]),
  workspace: { root: "/workspace", dataRoot: kernel.dataRoot },
  limits: { sourceBytes: CellTool.maxSourceBytes, channelBytes: 4_096, cellDeadlineMillis: 1_000 },
  trustMode: "trusted-local",
})

const request = (code: string, sessionId: string): ToolExecutor.Request => {
  const call = Response.makePart("tool-call", {
    id: "call-1",
    name: CellTool.name,
    params: { code },
    providerExecuted: false,
  })
  return { call, toolCallBatch: { calls: [call] }, turn: 0, toolCallIndex: 0, agentName: "rika-root", sessionId }
}

const executorFor = (configured: Effect.Success<ReturnType<typeof configure>>, name: string) => {
  const entry = configured.resolverEntries.find(({ agent }) => agent.name === name)!
  return entry.agent.open((_agent, environment) => environment)
}

/** The per-call context Baton installs around one tool execution, with the fiber's own signal. */
const cellContext = (sessionId: string) =>
  Effect.map(
    Effect.abortSignal,
    (signal): ToolContext.Interface => ({
      signal,
      emit: () => Effect.void,
      sessionId,
      toolCallId: `call-${sessionId}`,
      operationKey: `operation-${sessionId}`,
    }),
  )

it.effect("routes an admitted cell call through the kernel pool the host supplied", () =>
  Effect.gen(function* () {
    const executed: Array<string> = []
    const pool = TestKernel.layerTestPool({
      profile,
      script: (input) => {
        executed.push(input.code)
        return { _tag: "Value", value: `evaluated:${input.code}`, stdout: "out" }
      },
    })
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      kernelPool: yield* Layer.build(Layer.merge(pool, CellCallContext.layer)),
    })
    const environment = executorFor(configured, "rika-root")
    const context = yield* Layer.build(environment)
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const outcome = yield* executor
      .execute(request("1 + 1", "session-a"))
      .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-a")))
    expect(outcome._tag).toBe("Success")
    expect(executed).toEqual(["1 + 1"])
  }).pipe(Effect.scoped),
)

it.effect("keeps the pool alive for a second cell rather than releasing it with the first", () =>
  Effect.gen(function* () {
    const executed: Array<string> = []
    const pool = TestKernel.layerTestPool({
      profile,
      script: (input) => {
        executed.push(input.code)
        return { _tag: "Value", value: `evaluated:${input.code}` }
      },
    })
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      kernelPool: yield* Layer.build(Layer.merge(pool, CellCallContext.layer)),
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const run = (code: string) =>
      executor
        .execute(request(code, "session-a"))
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-a")))
    // A pool owned by the first cell's scope is released when that cell ends, and the closed map
    // answers the next cell with an interrupt rather than a worker, so the second cell never runs.
    const first = yield* run("1 + 1")
    const second = yield* run("2 + 2")
    expect(first._tag).toBe("Success")
    expect(second._tag).toBe("Success")
    expect(executed).toEqual(["1 + 1", "2 + 2"])
  }).pipe(Effect.scoped),
)

it.effect("uses the per-call tool context of each cell rather than one bound at layer build", () =>
  Effect.gen(function* () {
    const sessions: Array<string> = []
    const pool = TestKernel.layerTestPool({
      profile,
      script: (input) => {
        sessions.push(input.sessionId)
        return { _tag: "Value", value: input.code }
      },
    })
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      kernelPool: yield* Layer.build(Layer.merge(pool, CellCallContext.layer)),
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    for (const sessionId of ["session-a", "session-b"]) {
      yield* executor
        .execute(request("work", sessionId))
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext(sessionId)))
    }
    expect(sessions).toEqual(["session-a", "session-b"])
  }).pipe(Effect.scoped),
)

it.effect("fails typed when a cell is called without a kernel pool", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const failure = yield* Effect.flip(
      executor
        .execute(request("1", "session-a"))
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-a"))),
    )
    expect(failure._tag).toBe("tenetkit/core/FrameworkFailure")
    if (failure._tag === "tenetkit/core/FrameworkFailure") {
      expect(failure.tool).toBe(CellTool.name)
      expect(failure.message).toContain("kernel pool")
    }
  }).pipe(Effect.scoped),
)

it.effect("refuses any tool name other than the one advertised cell tool", () =>
  Effect.gen(function* () {
    const pool = TestKernel.layerTestPool({ profile })
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      kernelPool: yield* Layer.build(Layer.merge(pool, CellCallContext.layer)),
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const call = Response.makePart("tool-call", {
      id: "call-2",
      name: "bash",
      params: { command: "ls" },
      providerExecuted: false,
    })
    const failure = yield* Effect.flip(
      executor
        .execute({
          call,
          toolCallBatch: { calls: [call] },
          turn: 0,
          toolCallIndex: 0,
          agentName: "rika-root",
          sessionId: "session-a",
        })
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-a"))),
    )
    expect(failure._tag).toBe("tenetkit/core/FrameworkFailure")
    if (failure._tag === "tenetkit/core/FrameworkFailure") expect(failure.tool).toBe("bash")
  }).pipe(Effect.scoped),
)

it.effect("names an async deadline and keeps the next cell healthy", () =>
  Effect.gen(function* () {
    let invocation = 0
    const deadlineMillis = 120_000
    const pool = TestKernel.layerTestPool({
      profile,
      script: (input) => {
        invocation += 1
        return invocation === 1
          ? {
              _tag: "Failure",
              failure: Cell.CellExecutionFailed.make({
                cellId: input.cellId,
                epoch: 0,
                sequence: 0,
                name: "Cellaborted",
                message: "the cell was aborted by its host",
                stdout: "",
                stderr: "",
                durationMillis: deadlineMillis,
                truncation: [],
              }),
            }
          : { _tag: "Value", value: "2" }
      },
    })
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel: { ...kernel, limits: { ...profile.limits, cellDeadlineMillis: deadlineMillis } },
      kernelPool: yield* Layer.build(Layer.merge(pool, CellCallContext.layer)),
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const run = (code: string) =>
      executor
        .execute(request(code, "session-deadline"))
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-deadline")))
    const failed = yield* run("await new Promise(() => {})")
    expect(failed).toMatchObject({
      _tag: "DomainFailure",
      failure: {
        _tag: "tenetkit/repl/CellExecutionFailed",
        name: "CellDeadlineExceeded",
      },
    })
    if (failed._tag === "DomainFailure") {
      const failure = failed.failure as Cell.CellFailure
      if (failure._tag === "tenetkit/repl/CellExecutionFailed") {
        expect(failure.message).toContain("cell exceeded the 120s deadline")
        expect(failure.message).toContain("rika.processes.start")
      }
    }
    expect(yield* run("1 + 1")).toMatchObject({ _tag: "Success" })
  }).pipe(Effect.scoped),
)
