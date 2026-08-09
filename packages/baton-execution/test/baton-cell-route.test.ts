import { expect, it } from "@effect/vitest"
import { ToolContext, ToolExecutor } from "@batonfx/core"
import { CellTool, KernelProfile, TestKernel } from "@batonfx/repl"
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
      kernelPool: Layer.merge(pool, CellCallContext.layer),
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
      kernelPool: Layer.merge(pool, CellCallContext.layer),
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
    expect(failure._tag).toBe("@batonfx/core/FrameworkFailure")
    if (failure._tag === "@batonfx/core/FrameworkFailure") {
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
      kernelPool: Layer.merge(pool, CellCallContext.layer),
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
    expect(failure._tag).toBe("@batonfx/core/FrameworkFailure")
    if (failure._tag === "@batonfx/core/FrameworkFailure") expect(failure.tool).toBe("bash")
  }).pipe(Effect.scoped),
)
