import { expect, it } from "@effect/vitest"
import { ToolContext, ToolExecutor } from "tenetkit"
import { Cell, CellTool, KernelProfile, TestKernel } from "tenetkit/repl"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Response } from "effect/unstable/ai"
import { configure, remoteCellOperationOutcome } from "../src/route"
import * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as RemoteCells from "../src/remote-cells"
import * as CellAuthority from "@rika/kernel/test-cell-authority"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const
const executionIdentity = { threadId: "thread-1", turnId: "turn-1" } as const

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

const result = (cellId: string, value = "2") => ({
  cellId,
  epoch: 0,
  sequence: 0,
  value,
  stdout: "",
  stderr: "",
  durationMillis: 1,
  truncation: [],
})

const remoteRequest = RemoteCells.Request.make({
  operationKey: "operation-recovery",
  workspaceId: "workspace-1",
  sessionId: "session-recovery",
  threadId: "thread-1",
  turnId: "turn-1",
  runId: "run-1",
  rootRunId: "run-1",
  toolCallId: "call-recovery",
  code: "1 + 1",
  attempt: 0,
  replayPolicy: "provider-idempotent",
  admittedAt: "2026-08-25T00:00:00.000Z",
  deadlineAt: "2026-08-25T00:01:00.000Z",
})

/** The per-call context TenetKit installs around one tool execution, with the fiber's own signal. */
const cellContext = (sessionId: string) =>
  Effect.map(
    Effect.abortSignal,
    (signal): ToolContext.Interface => ({
      signal,
      emit: () => Effect.void,
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

it.effect("reconstructs the exact durable tool outcome from a retained remote completion", () =>
  Effect.gen(function* () {
    const cell = result("operation-recovery", "42")
    expect(yield* remoteCellOperationOutcome(remoteRequest, { _tag: "Success", result: cell })).toEqual({
      _tag: "Success",
      result: cell,
      encodedResult: cell,
    })
    expect(
      yield* remoteCellOperationOutcome(remoteRequest, {
        _tag: "DomainFailure",
        failure: { kind: "unknown", message: "delivery acknowledgement was lost" },
      }),
    ).toMatchObject({
      _tag: "DomainFailure",
      failure: {
        _tag: "tenetkit/repl/CellOutcomeUnknown",
        sessionId: "session-recovery",
        cellId: "call-recovery",
        reason: "transport-lost",
      },
      encodedFailure: {
        _tag: "tenetkit/repl/CellOutcomeUnknown",
        sessionId: "session-recovery",
        cellId: "call-recovery",
        reason: "transport-lost",
      },
    })
  }),
)

it.effect("decodes an encoded remote cell failure before returning it to TenetKit", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: () =>
            Effect.succeed({
              _tag: "DomainFailure",
              failure: {
                _tag: "tenetkit/repl/CellExecutionFailed",
                cellId: "call-session-failed",
                epoch: 0,
                sequence: 1,
                name: "Error",
                message: "The requested operation failed",
                stack: "Error: The requested operation failed",
                stdout: "",
                stderr: "",
                durationMillis: 250,
                truncation: [],
              },
            }),
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const outcome = yield* withCellAuthority(
      executor
        .execute(request("throw new Error()", "session-failed"))
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-failed"))),
      "session-failed",
    )
    expect(outcome).toMatchObject({
      _tag: "DomainFailure",
      failure: {
        _tag: "tenetkit/repl/CellExecutionFailed",
        message: "The requested operation failed",
      },
    })
  }).pipe(Effect.scoped),
)

it.effect("turns a remote transport loss into a model-visible uncertain cell outcome", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: () =>
            Effect.succeed({
              _tag: "DomainFailure",
              failure: { kind: "unknown", message: "Executor disconnected after accepting the cell" },
            }),
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const outcome = yield* withCellAuthority(
      executor
        .execute(request("work()", "session-lost"))
        .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-lost"))),
      "session-lost",
    )
    expect(outcome).toMatchObject({
      _tag: "DomainFailure",
      failure: {
        _tag: "tenetkit/repl/CellOutcomeUnknown",
        sessionId: "session-lost",
        cellId: "call-session-lost",
        reason: "transport-lost",
      },
    })
  }).pipe(Effect.scoped),
)

it.effect("rejects an invalid remote cell response at the schema boundary", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: () => Effect.succeed({ _tag: "Success", result: { value: 2 } }),
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const failure = yield* Effect.flip(
      withCellAuthority(executor.execute(request("1", "session-invalid")), "session-invalid"),
    )
    expect(failure._tag).toBe("tenetkit/core/FrameworkFailure")
    if (failure._tag === "tenetkit/core/FrameworkFailure") {
      expect(failure.stage).toBe("placement")
      expect(failure.message).toContain("remote cell response is invalid")
    }
  }).pipe(Effect.scoped),
)

it.effect("does not blindly retry a remote cell whose outcome is unknown", () =>
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
            return RemoteCells.UnknownOutcome.make({ message: "dispatch acknowledgement was lost" })
          },
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const failure = yield* Effect.flip(
      withCellAuthority(executor.execute(request("1 + 1", "session-unknown")), "session-unknown"),
    )
    expect(failure).toMatchObject({
      _tag: "tenetkit/core/FrameworkFailure",
      message: "dispatch acknowledgement was lost",
    })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      operationKey: "operation-session-unknown",
      replayPolicy: "provider-idempotent",
    })
  }).pipe(Effect.scoped),
)

it.effect("accepts the same deduplicated remote result after recovered dispatch", () =>
  Effect.gen(function* () {
    const cached = new Map<string, unknown>()
    let executions = 0
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      executionIdentity,
      kernel,
      cell: {
        _tag: "Remote",
        cells: RemoteCells.layer({
          execute: (input) => {
            const duplicate = cached.get(input.operationKey)
            if (duplicate !== undefined) return Effect.succeed(duplicate)
            executions += 1
            const response = { _tag: "Success" as const, result: result(input.operationKey, "42") }
            cached.set(input.operationKey, response)
            return Effect.succeed(response)
          },
        }),
        admit: () => Effect.void,
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const execute = withCellAuthority(executor.execute(request("6 * 7", "session-recovered")), "session-recovered")
    const first = yield* execute
    const recovered = yield* execute
    expect(recovered).toEqual(first)
    expect(executions).toBe(1)
  }).pipe(Effect.scoped),
)

it.effect("refuses any tool name other than the one advertised cell tool", () =>
  Effect.gen(function* () {
    const pool = TestKernel.layerTestPool({ profile })
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
    const call = Response.makePart("tool-call", {
      id: "call-2",
      name: "bash",
      params: { command: "ls" },
      providerExecuted: false,
    })
    const failure = yield* Effect.flip(
      withCellAuthority(
        executor.execute({
          call,
          toolCallBatch: { calls: [call] },
          turn: 0,
          toolCallIndex: 0,
          agentName: "rika-root",
          sessionId: "session-a",
        }),
        "session-a",
      ),
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
      cell: {
        _tag: "Local",
        services: yield* Layer.build(Layer.merge(pool, ExecutorRuntime.cellContextLayer)),
      },
    })
    const context = yield* Layer.build(executorFor(configured, "rika-root"))
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const run = (code: string) =>
      withCellAuthority(executor.execute(request(code, "session-deadline")), "session-deadline")
    const failed = yield* run("await new Promise(() => {})")
    expect(failed).toMatchObject({
      _tag: "DomainFailure",
      failure: {
        _tag: "tenetkit/repl/CellExecutionFailed",
        name: "CellDeadlineExceeded",
      },
    })
    if (failed._tag === "DomainFailure") {
      const failure = Schema.decodeUnknownOption(Cell.CellFailure)(failed.failure)
      if (Option.isSome(failure) && failure.value._tag === "tenetkit/repl/CellExecutionFailed") {
        expect(failure.value.message).toContain("cell exceeded the 120s deadline")
        expect(failure.value.message).toContain("rika.processes.start")
      }
    }
    expect(yield* run("1 + 1")).toMatchObject({ _tag: "Success" })
  }).pipe(Effect.scoped),
)
