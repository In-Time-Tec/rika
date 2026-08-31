import { expect, it } from "@effect/vitest"
import { ToolContext, ToolExecutor } from "tenetkit"
import { CellTool, KernelProfile, TestKernel } from "tenetkit/repl"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer } from "effect"
import { Response } from "effect/unstable/ai"
import { configure } from "../src/routing/route"
import * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as RemoteCells from "../src/remote-cells"
import * as CellAuthority from "@rika/kernel/test-cell-authority"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const
const executionIdentity = { threadId: "thread-1", turnId: "turn-1" } as const

const profile = KernelProfile.make({
  provider: "tenetkit/repl/bun",
  runtime: { name: "bun", version: kernel.runtimeVersion, digest: "runtime-digest" },
  image: { kind: "runtime", reference: `bun@${kernel.runtimeVersion}`, digest: "runtime-digest" },
  isolation: "host-process",
  checkpoints: { liveProcess: true, filesystem: false, namespace: true },
  bindingsDigest: KernelProfile.bindingsDigest(["workspace"]),
  workspace: { root: "/workspace", dataRoot: kernel.dataRoot },
  limits: { sourceBytes: CellTool.maxSourceBytes, cellDeadlineMillis: 1_000 },
})

const request = (code: string, sessionId: string): ToolExecutor.Request => {
  const call: Response.ToolCallPart<typeof CellTool.name, { readonly code: string }> = Response.toolCallPart({
    id: "call-1",
    name: CellTool.name,
    params: { code },
    providerExecuted: false,
    metadata: {},
  })
  return { call, toolCallBatch: { calls: [call] }, turn: 0, toolCallIndex: 0, agentName: "rika-root", sessionId }
}

const executorFor = (configured: Effect.Success<ReturnType<typeof configure>>, name: string) => {
  const entry = configured.resolverEntries.find(({ agent }) => agent.name === name)!
  return entry.agent.open((_agent, environment) => environment)
}

const result = (cellId: string, value = "2") => ({
  cellId,
  epoch: 0,
  sequence: 0,
  value,
  stdout: "",
  stderr: "",
  durationMillis: 1,
})

/** The per-call context TenetKit installs around one tool execution, with the fiber's own signal. */
const cellContext = (sessionId: string) =>
  Effect.map(
    Effect.abortSignal,
    (signal): ToolContext.Service => ({
      signal,
      emit: () => Effect.succeed(true),
      sessionId,
      toolCallId: `call-${sessionId}`,
      operationKey: `operation-${sessionId}`,
      runId: `run-${sessionId}`,
      rootRunId: `root-${sessionId}`,
      attempt: 0,
    }),
  )

const withCellAuthority = <A, E, R>(effect: Effect.Effect<A, E, R>, sessionId: string) =>
  Effect.flatMap(cellContext(sessionId), (toolContext) =>
    Effect.flatMap(CellAuthority.context(toolContext), (authority) => Effect.provideContext(effect, authority)),
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
      cell: {
        _tag: "Local",
        services: yield* Layer.build(Layer.merge(pool, ExecutorRuntime.cellContextLayer)),
      },
    })
    const environment = executorFor(configured, "rika-root")
    const context = yield* Layer.build(environment)
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const outcome = yield* withCellAuthority(executor.execute(request("1 + 1", "session-a")), "session-a")
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
      cell: {
        _tag: "Local",
        services: yield* Layer.build(Layer.merge(pool, ExecutorRuntime.cellContextLayer)),
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const run = (code: string) => withCellAuthority(executor.execute(request(code, "session-a")), "session-a")
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
      cell: {
        _tag: "Local",
        services: yield* Layer.build(Layer.merge(pool, ExecutorRuntime.cellContextLayer)),
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    for (const sessionId of ["session-a", "session-b"]) {
      yield* withCellAuthority(executor.execute(request("work", sessionId)), sessionId)
    }
    expect(sessions).toEqual(["session-a", "session-b"])
  }).pipe(Effect.scoped),
)

it.effect("routes a cell through the explicit remote adapter without a kernel pool", () =>
  Effect.gen(function* () {
    const dispatched: Array<RemoteCells.Request> = []
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: (input) => {
            dispatched.push(input)
            return Effect.succeed({ _tag: "Success", result: result(input.operationKey) })
          },
          cancel: () => Effect.die("unused"),
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const outcome = yield* withCellAuthority(executor.execute(request("1", "session-a")), "session-a")
    expect(outcome).toMatchObject({ _tag: "Success", result: { value: "2" } })
    expect(dispatched).toEqual([
      expect.objectContaining({
        operationKey: "operation-session-a",
        workspaceId: "/workspace",
        sessionId: "session-a",
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-session-a",
        rootRunId: "root-session-a",
        toolCallId: "call-session-a",
        attempt: 0,
        code: "1",
        replayPolicy: "provider-idempotent",
      }),
    ])
  }).pipe(Effect.scoped),
)

it.effect("cancels the exact admitted remote cell identity and redelivers it unchanged", () =>
  Effect.gen(function* () {
    const cancellations: Array<RemoteCells.CancellationRequest> = []
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: () => Effect.die("unused"),
          cancel: (input) => {
            cancellations.push(input)
            return Effect.succeed({
              _tag: "DomainFailure",
              failure: { kind: "cancelled", message: "Cell operation cancelled" },
            })
          },
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const execution = request("await rika.processes.start({ command: 'sleep 30' })", "session-cancel")
    const cancellation: ToolExecutor.CancellationRequest = {
      operationKey: "operation-cancel",
      attempt: 3,
      sessionId: "session-cancel",
      runId: "run-cancel",
      rootRunId: "root-cancel",
      toolCallId: execution.call.id,
      toolName: CellTool.name,
      execution,
    }
    const cancel = executor.cancel!(cancellation).pipe(
      Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-cancel")),
    )
    expect(executor.cancellable?.(execution)).toBe(true)
    expect(yield* cancel).toEqual({ _tag: "Cancelled" })
    expect(yield* cancel).toEqual({ _tag: "Cancelled" })
    expect(cancellations).toEqual([
      {
        operationKey: "operation-cancel",
        workspaceId: "/workspace",
        sessionId: "session-cancel",
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-cancel",
        rootRunId: "root-cancel",
        toolCallId: "call-1",
        code: "await rika.processes.start({ command: 'sleep 30' })",
        attempt: 3,
        replayPolicy: "provider-idempotent",
      },
      {
        operationKey: "operation-cancel",
        workspaceId: "/workspace",
        sessionId: "session-cancel",
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-cancel",
        rootRunId: "root-cancel",
        toolCallId: "call-1",
        code: "await rika.processes.start({ command: 'sleep 30' })",
        attempt: 3,
        replayPolicy: "provider-idempotent",
      },
    ])
  }).pipe(Effect.scoped),
)

it.effect("reports a remote success or domain failure that won the cancellation race", () =>
  Effect.gen(function* () {
    const completed = result("operation-terminal", "finished")
    const failed = {
      _tag: "tenetkit/repl/CellExecutionFailed" as const,
      cellId: "call-1",
      epoch: 0,
      sequence: 1,
      name: "Error",
      message: "execution completed with a failure",
      stdout: "",
      stderr: "",
      durationMillis: 1,
    }
    const responses: Array<RemoteCells.TransportResponse> = [
      { _tag: "Success", result: completed },
      { _tag: "DomainFailure", failure: failed },
    ]
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: () => Effect.die("unused"),
          cancel: () => Effect.succeed(responses.shift()!),
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const execution = request("work()", "session-terminal")
    const cancellation: ToolExecutor.CancellationRequest = {
      operationKey: "operation-terminal",
      attempt: 0,
      sessionId: "session-terminal",
      runId: "run-terminal",
      rootRunId: "run-terminal",
      toolCallId: execution.call.id,
      toolName: CellTool.name,
      execution,
    }
    const cancel = () =>
      executor.cancel!(cancellation).pipe(
        Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-terminal")),
      )
    expect(yield* cancel()).toEqual({
      _tag: "AlreadyTerminal",
      outcome: { _tag: "Success", result: completed, encodedResult: completed },
    })
    const failedOutcome = yield* cancel()
    expect(failedOutcome).toMatchObject({
      _tag: "AlreadyTerminal",
      outcome: {
        _tag: "DomainFailure",
        failure: { _tag: "tenetkit/repl/CellExecutionFailed", message: "execution completed with a failure" },
        encodedFailure: {
          _tag: "tenetkit/repl/CellExecutionFailed",
          message: "execution completed with a failure",
        },
      },
    })
  }).pipe(Effect.scoped),
)

it.effect("keeps an unknown cancellation outcome pending for TenetKit recovery", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: () => Effect.die("unused"),
          cancel: () =>
            Effect.succeed({
              _tag: "DomainFailure",
              failure: { kind: "unknown", message: "cancellation delivery is not definitive" },
            }),
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const execution = request("work()", "session-unknown-cancel")
    const failure = yield* Effect.flip(
      executor.cancel!({
        operationKey: "operation-unknown-cancel",
        attempt: 0,
        sessionId: "session-unknown-cancel",
        runId: "run-unknown-cancel",
        rootRunId: "run-unknown-cancel",
        toolCallId: execution.call.id,
        toolName: CellTool.name,
        execution,
      }).pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-unknown-cancel"))),
    )
    expect(failure).toMatchObject({
      _tag: "@tenetkit/core/CancellationFailure",
      tool: CellTool.name,
      message: "cancellation delivery is not definitive",
    })
  }).pipe(Effect.scoped),
)
