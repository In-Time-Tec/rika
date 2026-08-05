import { expect, it } from "@effect/vitest"
import { ExecutableResolver, ExecutionHost, Run, RunStore, RunEvent, Runtime } from "@batonfx/runtime"
import { TestModel } from "@batonfx/test"
import { ModelRegistry, SandboxExecutor } from "@batonfx/core"
import { Database } from "bun:sqlite"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Random, Schedule, Schema, Stream } from "effect"
import type { Tool, Toolkit } from "effect/unstable/ai"
import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import { layer, projectEvent } from "../src/baton-execution"
import { configure } from "../src/baton-route"

const registryLayer = (fixture: TestModel.Fixture) =>
  ModelRegistry.layer([Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })])

const stubHandlers = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  toolkit.toLayer(
    Object.fromEntries(Object.keys(toolkit.tools).map((name) => [name, () => Effect.succeed({})])) as never,
  )

const agentServices = Layer.mergeAll(stubHandlers(RoleToolkits.root), stubHandlers(RoleToolkits.readThread))

const promptJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const sandbox = SandboxExecutor.makeTest(() => Effect.die(new Error("unexpected Program execution")), {
  language: "javascript",
  implementation: "rika-execution-test-sandbox",
  version: "1",
  memoryBytes: 1024,
  stackBytes: 1024,
})

const testLayer = (options: Parameters<typeof layer>[0]) =>
  layer(options).pipe(Layer.provide(Layer.succeed(SandboxExecutor.SandboxExecutor, sandbox)))

const routeWithIdentity = (identity: string) => {
  const route = testExecutionRoute()
  return {
    ...route,
    main: {
      ...route.main,
      registrationIdentity: identity as typeof route.main.registrationIdentity,
      candidates: route.main.candidates.map((candidate) =>
        Object.assign({}, candidate, { registrationIdentity: identity as typeof candidate.registrationIdentity }),
      ),
    },
  }
}

it.live(
  "exposes exactly five operations around one opaque root Run tree",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-${yield* Random.nextInt}.db`
      const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("durable response")])], {
        provider: "test",
        model: "test",
        registrationKey: "test-route",
      })
      const route = routeWithIdentity("test-route")
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(testLayer({ filename, modelServices: registryLayer(fixture) }))
          const gateway = Context.get(context, ExecutionGateway.Service)
          expect(Object.keys(gateway).toSorted()).toEqual([
            "cancelTurn",
            "inspectTurn",
            "startTurn",
            "steerTurn",
            "watchTurn",
          ])
          const link = yield* gateway.startTurn({
            threadId: "thread-1",
            turnId: "turn-1",
            workspace: "/workspace",
            prompt: "reply with image context",
            promptParts: [
              { type: "text", text: "reply with image context" },
              { type: "image", mediaType: "image/png", data: "AQ==", filename: "context.png" },
            ],
            executionRoute: route,
          })
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          const view = yield* gateway.inspectTurn(link)
          return { link, events: [...events], view }
        }),
      )
      expect(result.link.runId).not.toBe(result.link.turnId)
      expect(result.link.runId).not.toContain(result.link.threadId)
      expect(
        result.events.some((event) => event.type === "model.output.completed" && event.text === "durable response"),
      ).toBe(true)
      expect(
        result.events.some(
          (event) => event.type === "model.attempt.completed" && typeof event.data?.model_attempt_id === "string",
        ),
      ).toBe(true)
      expect(result.events.at(-1)?.type).toBe("execution.completed")
      expect(result.events.at(-1)?.cursor).toMatch(/^baton-tree:/)
      expect(result.view.status).toBe("completed")
      expect(result.view.cursor).toMatch(/^baton-tree:/)
      const requestPrompt = promptJson((yield* fixture.requests)[0]?.prompt)
      expect(requestPrompt).toContain('"type":"file"')
      expect(requestPrompt).toContain('"mediaType":"image/png"')
      expect(requestPrompt).toContain('"fileName":"context.png"')
    }),
  60_000,
)

it.live(
  "runs a requested title as a parent-relative child without projecting it as assistant output",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-${yield* Random.nextInt}.db`
      const fixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("generated title")]), TestModel.turn([TestModel.text("root response")])],
        { provider: "test", model: "test", registrationKey: "title-route" },
      )
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(testLayer({ filename, modelServices: registryLayer(fixture) }))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const input = {
            threadId: "thread-title",
            turnId: "turn-title",
            workspace: "/workspace",
            prompt: "Explain the title child",
            executionRoute: routeWithIdentity("title-route"),
            titleIntent: { _tag: "GenerateThreadTitle" as const, expectedTitle: "Explain the title child" },
          }
          const link = yield* gateway.startTurn(input)
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          return { events: [...events], link, duplicate: yield* gateway.startTurn(input) }
        }),
      )
      expect(result.duplicate).toEqual(result.link)
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "thread.title.generated",
          data: { title: "generated title", invocation_id: "rika.thread-title" },
        }),
      )
      expect(
        result.events.some((event) => event.childExecutionId !== undefined && event.type.startsWith("model.output")),
      ).toBe(false)
      expect(result.events.filter((event) => event.type === "model.attempt.completed")).toHaveLength(2)
      expect(result.events.some((event) => event.type === "child_run.spawned")).toBe(false)
    }),
  60_000,
)

it.live(
  "runs root and Task product tools through durable parent-relative child calls",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-child-tools-${yield* Random.nextInt}.db`
      const fixture = yield* TestModel.make(
        [
          TestModel.turn([TestModel.toolCall("task", { prompt: "delegate the bounded task" }, { id: "task-call" })]),
          TestModel.turn([TestModel.toolCall("oracle", { prompt: "analyze the evidence" }, { id: "oracle-call" })]),
          TestModel.turn([TestModel.text("oracle report")]),
          TestModel.turn([TestModel.text("task report")]),
          TestModel.turn([TestModel.text("root report")]),
        ],
        { provider: "test", model: "test", registrationKey: "child-tools-route" },
      )
      const input = {
        threadId: "thread-child-tools",
        turnId: "turn-child-tools",
        workspace: "/workspace",
        prompt: "use nested children",
        executionRoute: routeWithIdentity("child-tools-route"),
      }
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({ filename, modelServices: registryLayer(fixture), agentServices: () => agentServices }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn(input)
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          const duplicate = yield* gateway.startTurn(input)
          return { duplicate, events: [...events], link }
        }),
      )
      const reopened = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({ filename, modelServices: registryLayer(fixture), agentServices: () => agentServices }),
          )
          return yield* Context.get(context, ExecutionGateway.Service).startTurn(input)
        }),
      )
      expect(result.duplicate).toEqual(result.link)
      expect(reopened).toEqual(result.link)
      expect(result.events.filter(({ type }) => type === "child_run.spawned")).toHaveLength(2)
      expect(result.events.some(({ text }) => text === "oracle report")).toBe(true)
      expect(result.events.some(({ text }) => text === "task report")).toBe(true)
      expect(result.events.some(({ text }) => text === "root report")).toBe(true)
      const requests = yield* fixture.requests
      expect(requests).toHaveLength(5)
      expect(promptJson(requests[3]?.prompt)).toContain("oracle report")
      expect(promptJson(requests[4]?.prompt)).toContain("task report")
    }),
  60_000,
)

it.live("resumes a queued Run through ExecutionHost without replacing its opaque ID", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-baton-queued-${yield* Random.nextInt}.db`
    const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("recovered response")])], {
      provider: "test",
      model: "test",
      registrationKey: "queued-route",
    })
    const baseRoute = routeWithIdentity("queued-route")
    const route = {
      ...baseRoute,
      main: {
        ...baseRoute.main,
        candidates: [
          ...baseRoute.main.candidates.map((candidate) =>
            Object.assign({}, candidate, {
              providerConnection: Object.assign({}, candidate.providerConnection, {
                apiKeyEnvironment: "RIKA_QUEUED_API_KEY",
              }),
            }),
          ),
          {
            ...baseRoute.main.candidates[0]!,
            registrationIdentity:
              "queued-route-fallback" as (typeof baseRoute.main.candidates)[number]["registrationIdentity"],
            providerConnection: Object.assign({}, baseRoute.main.candidates[0]!.providerConnection, {
              apiKeyEnvironment: "RIKA_QUEUED_API_KEY",
            }),
          },
        ],
      },
    }
    const configured = yield* configure({
      executionRoute: route,
      workspace: "/unseen",
      sandbox,
      modelServices: registryLayer(fixture),
    })
    const receipt = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Runtime.layerSqlite({
            filename,
            resolver: ExecutableResolver.makeStatic(configured.resolverEntries),
            addresses: [],
          }),
        )
        expect(Context.get(context, ExecutionHost.ExecutionHost)).toBeDefined()
        expect(Context.get(context, RunStore.RunStore)).toBeDefined()
        return yield* Context.get(context, Runtime.Runtime).start({
          executable: configured.executable,
          registrations: configured.registrations,
          sessionId: "thread-queued",
          idempotencyKey: "turn-queued",
          prompt: "recover me",
        })
      }),
    )
    const reconstructedWorkspaces: Array<string> = []
    const events = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          testLayer({
            filename,
            modelServices: registryLayer(fixture),
            agentServices: (workspace) => {
              reconstructedWorkspaces.push(workspace)
              return agentServices
            },
          }),
        )
        const gateway = Context.get(context, ExecutionGateway.Service)
        return yield* gateway
          .watchTurn({ runId: receipt.runId, threadId: "thread-queued", turnId: "turn-queued" })
          .pipe(Stream.runCollect)
      }),
    )
    expect([...events].some((event) => event.text === "recovered response")).toBe(true)
    expect(reconstructedWorkspaces).toContain("/unseen")
    expect(new Set(reconstructedWorkspaces)).toEqual(new Set(["/unseen"]))
    expect(yield* fixture.requests).toHaveLength(1)
    const database = new Database(filename)
    const registrations = database
      .query<{ payload_json: string }, []>("SELECT payload_json FROM baton_executable_registrations")
      .all()
    database.close()
    expect(registrations.map(({ payload_json }) => payload_json).join("\n")).toContain("RIKA_QUEUED_API_KEY")
    const persisted = registrations.map(({ payload_json }) => payload_json).join("\n")
    expect(persisted.indexOf("queued-route")).toBeLessThan(persisted.indexOf("queued-route-fallback"))
    expect(registrations.map(({ payload_json }) => payload_json).join("\n")).not.toContain("resolved-secret")
  }),
)

it.live("keeps exact Turn admission idempotent and rejects changed admission", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-baton-idempotency-${yield* Random.nextInt}.db`
    const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("done")])], {
      provider: "test",
      model: "test",
      registrationKey: "idempotent-route",
    })
    const route = routeWithIdentity("idempotent-route")
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(testLayer({ filename, modelServices: registryLayer(fixture) }))
        const gateway = Context.get(context, ExecutionGateway.Service)
        const input = {
          threadId: "thread-idempotent",
          turnId: "turn-idempotent",
          workspace: "/workspace",
          prompt: "same",
          executionRoute: route,
        }
        const first = yield* gateway.startTurn(input)
        const duplicate = yield* gateway.startTurn(input)
        expect(duplicate).toEqual(first)
        expect(yield* gateway.startTurn({ ...input, prompt: "changed" }).pipe(Effect.flip)).toBeInstanceOf(
          ExecutionGateway.StartTurnFailure,
        )
        expect(yield* gateway.startTurn({ ...input, workspace: "/changed" }).pipe(Effect.flip)).toBeInstanceOf(
          ExecutionGateway.StartTurnFailure,
        )
      }),
    )
  }),
)

it.live("steers the linked root and durably cancels its active child closure", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-baton-control-${yield* Random.nextInt}.db`
    const fixture = yield* TestModel.make(
      [
        TestModel.turn([TestModel.toolCall("task", { prompt: "wait in child" }, { id: "cancel-child" })]),
        TestModel.turn([TestModel.text("too late")], { delay: 5_000 }),
      ],
      { provider: "test", model: "test", registrationKey: "control-route" },
    )
    const route = routeWithIdentity("control-route")
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          testLayer({ filename, modelServices: registryLayer(fixture), agentServices: () => agentServices }),
        )
        const gateway = Context.get(context, ExecutionGateway.Service)
        const link = yield* gateway.startTurn({
          threadId: "thread-control",
          turnId: "turn-control",
          workspace: "/workspace",
          prompt: "wait",
          executionRoute: route,
        })
        yield* fixture.requests.pipe(
          Effect.repeat({ until: (requests) => requests.length > 1, schedule: Schedule.spaced("10 millis") }),
        )
        yield* gateway.steerTurn(link, { text: "new direction", idempotencyKey: "steer-1" })
        yield* gateway.cancelTurn(link, "stop")
        return { link, events: yield* gateway.watchTurn(link).pipe(Stream.runCollect) }
      }),
    )

    const childCancellationIndex = result.events.findIndex(
      (event) => event.childExecutionId !== undefined && event.type === "execution.cancelled",
    )
    const rootCancellationIndex = result.events.findIndex(
      (event) => event.executionId === result.link.runId && event.type === "execution.cancelled",
    )
    expect(childCancellationIndex).toBeGreaterThanOrEqual(0)
    expect(rootCancellationIndex).toBeGreaterThan(childCancellationIndex)
  }),
)

it("projects executable-neutral completion without assuming an Agent result", () => {
  const executable = Effect.runSync(
    configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox }),
  ).executable
  const runId = Run.RunId.make("opaque-program-run")
  const event = RunEvent.RunEvent.make({
    _tag: "RunCompleted",
    specVersion: "1",
    eventId: "event-1",
    runId,
    sequence: 1,
    executableRef: executable.ref,
    rootRunId: runId,
    occurredAt: "2026-08-04T00:00:00.000Z",
    result: { _tag: "Program", value: { answer: 42 } },
  })

  expect(projectEvent({ source: event, cursor: "opaque-cursor" })).toEqual([
    expect.objectContaining({ type: "execution.completed", cursor: "opaque-cursor" }),
  ])
})

it("projects an unknown operation as a resolution requirement", () => {
  const executable = Effect.runSync(
    configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox }),
  ).executable
  const runId = Run.RunId.make("unknown-operation-run")
  const event = RunEvent.RunEvent.make({
    _tag: "OperationUnknown",
    specVersion: "1",
    eventId: "unknown-operation-event",
    runId,
    sequence: 2,
    executableRef: executable.ref,
    rootRunId: runId,
    occurredAt: "2026-08-04T00:00:00.000Z",
    operationId: "operation-1",
  })

  expect(projectEvent({ source: event, cursor: "baton-tree:unknown-operation" })).toEqual([
    expect.objectContaining({
      type: "execution.resolution.required",
      data: { operation_id: "operation-1" },
      cursor: "baton-tree:unknown-operation",
    }),
  ])
})

it("projects one authoritative flattened usage event per model attempt", () => {
  const executable = Effect.runSync(
    configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox }),
  ).executable
  const runId = Run.RunId.make("usage-run")
  const event = RunEvent.RunEvent.make({
    _tag: "ModelAttemptCompleted",
    specVersion: "1",
    eventId: "usage-event",
    runId,
    sequence: 7,
    executableRef: executable.ref,
    rootRunId: runId,
    occurredAt: "2026-08-04T00:00:01.000Z",
    deliveryId: "delivery",
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt",
    attempt: 2,
    completedAt: 1_000,
    usageAt: 900,
    usage: {
      inputTokens: { total: 30, uncached: 10, cacheRead: 15, cacheWrite: 5 },
      outputTokens: { total: 12, text: 8, reasoning: 4 },
    },
    finishReason: "stop",
    responseModel: "model",
  })

  expect(projectEvent({ source: event, cursor: "baton-tree:usage" })).toEqual([
    expect.objectContaining({
      cursor: "baton-tree:usage",
      createdAt: 900,
      type: "model.attempt.completed",
      data: expect.objectContaining({
        model_call_id: "call",
        model_attempt_id: "attempt",
        attempt: 2,
        input_tokens: 30,
        input_tokens_uncached: 10,
        input_tokens_cache_read: 15,
        input_tokens_cache_write: 5,
        output_tokens: 12,
        output_tokens_text: 8,
        output_tokens_reasoning: 4,
      }),
    }),
  ])
})

it("projects child admission and settlement with explicit run and invocation identity", () => {
  const executable = Effect.runSync(
    configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox }),
  ).executable
  const runId = Run.RunId.make("parent-run")
  const childRunId = Run.RunId.make("child-run")
  const base = {
    specVersion: "1" as const,
    runId,
    executableRef: executable.ref,
    rootRunId: runId,
    occurredAt: "2026-08-04T00:00:01.000Z",
  }
  const linked = RunEvent.RunEvent.make({
    ...base,
    _tag: "ChildLinked",
    eventId: "child-linked",
    sequence: 1,
    childRunId,
    invocationId: "agent",
  })
  const settled = RunEvent.RunEvent.make({
    ...base,
    _tag: "ChildSettled",
    eventId: "child-settled",
    sequence: 2,
    childRunId,
    terminalEventId: "child-terminal",
  })

  expect(projectEvent({ source: linked, cursor: "baton-tree:linked" })).toEqual([
    expect.objectContaining({
      type: "child_run.spawned",
      data: { child_execution_id: "child-run", invocation_id: "agent" },
    }),
  ])
  expect(projectEvent({ source: settled, cursor: "baton-tree:settled" })).toEqual([
    expect.objectContaining({
      type: "child_run.settled",
      data: { child_execution_id: "child-run", terminal_event_id: "child-terminal" },
    }),
  ])
})

it("projects canonical fan-out admission and settlement lifecycle", () => {
  const executable = Effect.runSync(
    configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox }),
  ).executable
  const runId = Run.RunId.make("fan-out-run")
  const base = {
    specVersion: "1" as const,
    runId,
    executableRef: executable.ref,
    rootRunId: runId,
    occurredAt: "2026-08-04T00:00:01.000Z",
  }
  const admitted = RunEvent.RunEvent.make({
    ...base,
    _tag: "FanOutAdmitted",
    eventId: "fan-out-admitted",
    sequence: 8,
    fanOutId: "fan-out",
    memberCount: 3,
    concurrency: 2,
    join: { _tag: "AllSettled" },
    remainder: "await",
  })
  const joined = RunEvent.RunEvent.make({
    ...base,
    _tag: "FanOutJoined",
    eventId: "fan-out-joined",
    sequence: 9,
    fanOutId: "fan-out",
    status: "failed",
    succeeded: 1,
    failed: 1,
    cancelled: 1,
    abandoned: 0,
    remainder: [{ childRunId: Run.RunId.make("child"), action: "cancellation-requested" }],
  })

  expect(projectEvent({ source: admitted, cursor: "baton-tree:admitted" })).toEqual([
    expect.objectContaining({
      type: "fan_out.admitted",
      data: {
        fan_out_id: "fan-out",
        member_count: 3,
        concurrency: 2,
        join: "AllSettled",
        remainder: "await",
      },
    }),
  ])
  expect(projectEvent({ source: joined, cursor: "baton-tree:joined" })).toEqual([
    expect.objectContaining({
      type: "fan_out.joined",
      data: {
        fan_out_id: "fan-out",
        status: "failed",
        succeeded: 1,
        failed: 1,
        cancelled: 1,
        abandoned: 0,
        remainder: [{ childRunId: "child", action: "cancellation-requested" }],
      },
    }),
  ])
})

it("omits unavailable fields from completed attempt usage", () => {
  const executable = Effect.runSync(
    configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox }),
  ).executable
  const runId = Run.RunId.make("partial-usage-run")
  const event = RunEvent.RunEvent.make({
    _tag: "ModelAttemptCompleted",
    specVersion: "1",
    eventId: "partial-usage-event",
    runId,
    sequence: 10,
    executableRef: executable.ref,
    rootRunId: runId,
    occurredAt: "2026-08-04T00:00:01.000Z",
    deliveryId: "delivery",
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt",
    attempt: 0,
    completedAt: 1_000,
    usageAt: 900,
    usage: { inputTokens: { total: 30 }, outputTokens: {} },
    finishReason: "stop",
  })

  expect(projectEvent({ source: event })[0]?.data).toEqual({
    model_call_id: "call",
    model_attempt_id: "attempt",
    attempt: 0,
    input_tokens: 30,
    finish_reason: "stop",
  })
})
