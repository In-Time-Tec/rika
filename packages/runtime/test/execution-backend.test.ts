import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { vi } from "vitest"
import { ModelResilience } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { ChildFanOutHost, Client, Content, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { ThreadTools } from "@rika/tools"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Ref, Schedule, Schema, Stream, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { AiError, Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { createFanOut, currentExecutionRoute, start } from "./current-execution-route"

const MockEffect = vi.hoisted(() => (require("effect") as typeof import("effect")).Effect)

const native = vi.hoisted(() => ({
  client: undefined as Client.Interface | undefined,
  databaseAcquisitions: 0,
  runtimeGraphs: 0,
}))

const routeFor = (
  role: "main" | "oracle" | "compaction" | "librarian" | "painter" | "review" | "readThread" | "task",
  model: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
  compaction: { readonly contextWindow: number; readonly reserveTokens: number; readonly keepRecentTokens: number },
) => ({
  role,
  alias: role,
  ...model,
  registrationKey: model.registrationKey ?? "default",
  providerProtocol: "test" as const,
  providerBaseUrl: "test://model",
  effort: "medium",
  fast: false,
  requestVariant: "test",
  compaction,
})

vi.mock("@relayfx/sdk", (importOriginal) =>
  MockEffect.runPromise(
    MockEffect.gen(function* () {
      const actual = yield* MockEffect.tryPromise(() => importOriginal<typeof import("@relayfx/sdk")>())
      const { Layer: EffectLayer } = yield* MockEffect.tryPromise(() => import("effect"))
      return {
        ...actual,
        Client: {
          ...actual.Client,
          layerFromRuntime: EffectLayer.suspend(() => EffectLayer.succeed(actual.Client.Service, native.client!)),
        },
        Runtime: {
          ...actual.Runtime,
          layerEmbedded: (options: {
            readonly childFanOutHostLayer: Layer.Layer<ChildFanOutHost.Service>
            readonly workflowDefinitionHostLayer: Layer.Layer<WorkflowDefinitionHost.Service>
          }) => {
            native.runtimeGraphs += 1
            return EffectLayer.merge(options.childFanOutHostLayer, options.workflowDefinitionHostLayer).pipe(
              EffectLayer.provideMerge(EffectLayer.succeed(actual.Client.Service, native.client!)),
            )
          },
        },
      }
    }),
  ),
)

vi.mock("@relayfx/sdk/sqlite", () => ({
  SQLite: {
    database: () => {
      native.databaseAcquisitions += 1
      return {}
    },
  },
}))

const selection = { provider: "test", model: "model" }
const unused = () => Effect.die("unused client method")
const clientFailure = (message: string) => Client.ClientError.make({ message })
const relayEvent = (
  type: Execution.ExecutionEvent["type"],
  sequence: number,
  content?: Execution.ExecutionEvent["content"],
  data?: Execution.ExecutionEvent["data"],
): Execution.ExecutionEvent => ({
  id: Ids.EventId.make(`event:${sequence}`),
  execution_id: Ids.ExecutionId.make("execution:turn-a"),
  type,
  sequence,
  cursor: `cursor-${sequence}`,
  ...(content === undefined ? {} : { content }),
  ...(data === undefined ? {} : { data }),
  created_at: sequence * 10,
})

const makeClient = Effect.fn("ExecutionBackendTest.makeClient")(function* (options?: {
  readonly startStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly existingStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly streamEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly streamFailure?: string
  readonly replayEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly pageEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly openWaitIds?: ReadonlyArray<string>
  readonly cancelStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly unavailableLookups?: number
  readonly fail?: "register" | "start" | "lookup" | "replay" | "cancel"
}) {
  const registrations = yield* Ref.make<
    ReadonlyArray<{
      readonly id?: unknown
      readonly address?: unknown
      readonly agent?: unknown
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly permissions?: unknown
      readonly handoff_targets?: unknown
      readonly max_wait_turns?: unknown
    }>
  >([])
  const starts = yield* Ref.make<
    ReadonlyArray<Parameters<Client.Interface["executions"]["startByAgentDefinition"]>[0]>
  >([])
  const lookups = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["get"]>[0]>>([])
  const replays = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["replay"]>[0]>>([])
  const pages = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["pageEvents"]>[0]>>([])
  const cancellations = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["cancel"]>[0]>>([])
  const nextRevision = yield* Ref.make(40)
  const flat = {
    registerAgent: <Tools extends Record<string, import("effect/unstable/ai").Tool.Any>, Requirements>(
      input: Client.RegisterAgentInput<Tools, Requirements>,
    ) =>
      Ref.update(registrations, (values) => [...values, input]).pipe(
        Effect.andThen(Ref.getAndUpdate(nextRevision, (revision) => revision + 1)),
        Effect.flatMap((revision) =>
          options?.fail === "register"
            ? Effect.fail(clientFailure("register failed"))
            : Effect.succeed({
                record: {
                  id: input.id,
                  current_revision: revision,
                  definition: { name: "rika", model: selection, tool_names: [], permissions: [] },
                  created_at: 0,
                  updated_at: 0,
                },
              }),
        ),
      ),
    registerAgentDefinition: unused,
    getAgentDefinition: unused,
    listAgentDefinitions: unused,
    listAgentDefinitionRevisions: unused,
    getSkillDefinition: unused,
    listSkillDefinitions: unused,
    listSkillDefinitionRevisions: unused,
    registerAddressBookRoute: unused,
    getAddressBookRoute: unused,
    listAddressBookRoutes: unused,
    startExecution: unused,
    startExecutionByAddress: unused,
    startExecutionByAgentDefinition: (input: Parameters<Client.Interface["executions"]["startByAgentDefinition"]>[0]) =>
      Ref.update(starts, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "start"
            ? Effect.fail(clientFailure("start failed"))
            : Effect.succeed({
                execution_id: input.execution_id ?? Ids.ExecutionId.make("execution:fallback"),
                status: options?.startStatus ?? "running",
              }),
        ),
      ),
    cancelExecution: (input: Parameters<Client.Interface["executions"]["cancel"]>[0]) =>
      Ref.update(cancellations, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "cancel"
            ? Effect.fail(clientFailure("cancel failed"))
            : Effect.succeed({ execution_id: input.execution_id, status: options?.cancelStatus ?? "running" }),
        ),
      ),
    steer: unused,
    getExecution: (input: Parameters<Client.Interface["executions"]["get"]>[0]) =>
      Ref.update(lookups, (values) => [...values, input]).pipe(
        Effect.andThen(Ref.get(lookups)),
        Effect.flatMap((values) =>
          options?.fail === "lookup"
            ? Effect.fail(clientFailure("lookup failed"))
            : Effect.succeed(
                options?.existingStatus === undefined || values.length <= (options.unavailableLookups ?? 0)
                  ? undefined
                  : {
                      id: Ids.ExecutionId.make("execution:turn-a"),
                      root_address_id: Ids.AddressId.make("address:rika"),
                      status: options.existingStatus,
                      created_at: 1,
                      updated_at: 1,
                    },
              ),
        ),
      ),
    inspectExecution: () =>
      Effect.succeed({
        execution_id: Ids.ExecutionId.make("execution:turn-a"),
        status: options?.openWaitIds === undefined || options.openWaitIds.length === 0 ? "running" : "waiting",
        waiting_on: (options?.openWaitIds ?? []).map((waitId) => ({
          wait_id: Ids.WaitId.make(waitId),
          execution_id: Ids.ExecutionId.make("execution:turn-a"),
          mode: "reply" as const,
          state: "open" as const,
          metadata: {},
          created_at: 1,
        })),
        pending_tool_calls: [],
        child_runs: [],
      }),
    listExecutions: unused,
    listSessions: unused,
    getSession: unused,
    listWaits: unused,
    replayExecution: (input: Parameters<Client.Interface["executions"]["replay"]>[0]) =>
      Ref.update(replays, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "replay"
            ? Effect.fail(clientFailure("replay failed"))
            : Effect.succeed({ events: options?.replayEvents ?? [] }),
        ),
      ),
    pageExecutionEvents: (input: Parameters<Client.Interface["executions"]["pageEvents"]>[0]) =>
      Ref.update(pages, (values) => [...values, input]).pipe(
        Effect.as({
          events: options?.pageEvents ?? [],
          has_more: true,
          oldest_cursor: "oldest",
          newest_cursor: "newest",
        }),
      ),
    listRunners: unused,
    routeExecution: unused,
    send: unused,
    streamExecution: () =>
      options?.streamFailure === undefined
        ? Stream.fromIterable(options?.streamEvents ?? [])
        : Stream.concat(
            Stream.fromIterable(options.streamEvents ?? []),
            Stream.fail(clientFailure(options.streamFailure)),
          ),
    followExecution: () =>
      Stream.fromIterable(
        (options?.streamFailure === undefined
          ? options?.streamEvents
          : (options?.replayEvents ?? options?.streamEvents ?? [])
        )?.map((event) => ({ _tag: "event" as const, event })) ?? [],
      ),
    wake: unused,
    listPendingApprovals: unused,
    resolveToolApproval: unused,
    resolvePermission: unused,
    listPendingToolCalls: unused,
    fulfillToolCall: unused,
    claimToolWork: unused,
    completeToolWork: unused,
    releaseToolWork: unused,
    listToolAttempts: unused,
    submitInboundEnvelope: unused,
    spawnChildRun: unused,
    createChildFanOut: unused,
    inspectChildFanOut: unused,
    cancelChildFanOut: unused,
    registerWorkflowDefinition: unused,
    getWorkflowDefinitionRevision: unused,
    listWorkflowDefinitionRevisions: unused,
    startWorkflowRun: unused,
    inspectWorkflowRun: unused,
    replayWorkflowRun: unused,
    cancelWorkflowRun: unused,
    claimEnvelopeReady: unused,
    ackEnvelopeReady: unused,
    releaseEnvelopeReady: unused,
    createSchedule: unused,
    cancelSchedule: unused,
    listSchedules: unused,
    registerEntityKind: unused,
    getOrCreateEntity: unused,
    getEntity: unused,
    destroyEntity: unused,
    listEntities: unused,
    getEntityState: unused,
    putEntityState: unused,
    deleteEntityState: unused,
    listEntityState: unused,
    listInboxMessages: unused,
    askEntity: unused,
    awaitWait: unused,
    subscribeTopic: unused,
    unsubscribeTopic: unused,
    publishTopic: unused,
    listTopicSubscriptions: unused,
    getPresence: unused,
    streamSession: () => Stream.empty,
    watchExecutions: () => Stream.empty,
    watchPresence: () => Stream.empty,
  }
  const implementation = {
    agents: { register: flat.registerAgent },
    executions: {
      startByAgentDefinition: flat.startExecutionByAgentDefinition,
      cancel: flat.cancelExecution,
      steer: flat.steer,
      get: flat.getExecution,
      inspect: flat.inspectExecution,
      replay: flat.replayExecution,
      pageEvents: flat.pageExecutionEvents,
      stream: flat.streamExecution,
      follow: flat.followExecution,
    },
    tools: {
      listPendingApprovals: flat.listPendingApprovals,
      resolveApproval: flat.resolveToolApproval,
      resolvePermission: flat.resolvePermission,
    },
    childRuns: {
      spawn: flat.spawnChildRun,
      createFanOut: flat.createChildFanOut,
      inspectFanOut: flat.inspectChildFanOut,
      cancelFanOut: flat.cancelChildFanOut,
    },
    workflows: {
      registerDefinition: flat.registerWorkflowDefinition,
      startRun: flat.startWorkflowRun,
      inspectRun: flat.inspectWorkflowRun,
      cancelRun: flat.cancelWorkflowRun,
    },
    residents: {
      registerKind: flat.registerEntityKind,
      spawn: flat.getOrCreateEntity,
      get: flat.getEntity,
      destroy: flat.destroyEntity,
    },
    envelopes: { send: flat.send },
  } as unknown as Client.Interface
  return { implementation, registrations, starts, lookups, replays, pages, cancellations }
})

const provideConfiguredBackend = (
  implementation: Client.Interface,
  options: Parameters<typeof RelayExecutionBackend.layerFromClient>[0],
  additionalLayer: Layer.Layer<never> = Layer.empty,
) => {
  const contextLayer = Layer.merge(
    RelayExecutionBackend.layerFromClient(options).pipe(Layer.provide(Layer.succeed(Client.Service, implementation))),
    additionalLayer,
  )
  return <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(contextLayer)
      return yield* Effect.provide(effect, context)
    })
}

const provideBackend = (implementation: Client.Interface) => provideConfiguredBackend(implementation, { selection })

const provideBackendWithThreadTools = (implementation: Client.Interface) => {
  const contextLayer = RelayExecutionBackend.layerFromClient({
    selection,
    additionalToolkit: ThreadTools.toolkit,
  }).pipe(Layer.provide(Layer.succeed(Client.Service, implementation)))
  return <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(contextLayer)
      return yield* Effect.provide(effect, context)
    })
}

describe("ExecutionBackend Relay client adapter", () => {
  it("returns a completed final child response despite an internal tool failure terminal", () => {
    const events = [
      relayEvent("tool.call.requested", 1),
      relayEvent("tool.result.received", 2),
      relayEvent("model.output.completed", 3, [Content.text("Usable final response")]),
      relayEvent("execution.failed", 4, [], { message: "internal tool failed" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status: "completed",
      output: [Content.text("Usable final response")],
    })
  })

  it("does not recover a stale final response before later tool activity", () => {
    const events = [
      relayEvent("model.output.completed", 1, [Content.text("Stale response")]),
      relayEvent("tool.call.requested", 2),
      relayEvent("tool.result.received", 3),
      relayEvent("execution.failed", 4, [], { message: "internal tool failed" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status: "failed",
      output: [{ type: "text", text: "Subagent execution failed: internal tool failed" }],
    })
  })

  it("keeps cancellation authoritative after a completed final response", () => {
    const events = [
      relayEvent("model.output.completed", 1, [Content.text("Completed response")]),
      relayEvent("execution.cancelled", 2, [], { message: "cancelled" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status: "cancelled",
      output: [Content.text("Completed response")],
    })
  })

  it.each([
    ["execution.failed", "failed", "Subagent execution failed: terminal reason"],
    ["execution.cancelled", "cancelled", "Subagent execution was cancelled: terminal reason"],
  ] as const)("preserves %s when a child has no completed final response", (terminal, status, failureText) => {
    const events = [
      relayEvent("model.output.delta", 1, [Content.text("partial")]),
      relayEvent(terminal, 2, [], { message: "terminal reason" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status,
      output: [{ type: "text", text: failureText }],
    })
  })

  it("keeps preset inheritance separate from explicit child-run overrides", () => {
    const base = {
      child_execution_id: Ids.ChildExecutionId.make("child:one"),
      address_id: Ids.AddressId.make("address:rika"),
      input: [Content.text("Explore the runtime")],
    }
    const inherited = RelayExecutionBackend.buildChildRunInput(base, {
      _tag: "preset",
      presetName: "Task",
    })
    const explicit = RelayExecutionBackend.buildChildRunInput(base, {
      _tag: "override",
      definition: {
        instructions: "Complete the task",
        model: { provider: "test", model: "gpt-5.6-luna", registration_key: "luna-low" },
        tool_names: ["read"],
        permissions: ["workspace.read"],
        output_schema_ref: "rika.agent.task.v1",
        metadata: { product_profile: "Task", rika_reasoning_effort: "low" },
      },
    })

    expect(inherited).toEqual({ ...base, preset_name: "Task" })
    expect(Object.keys(inherited).toSorted()).toEqual(["address_id", "child_execution_id", "input", "preset_name"])
    expect(explicit).toEqual({
      ...base,
      instructions: "Complete the task",
      model: { provider: "test", model: "gpt-5.6-luna", registration_key: "luna-low" },
      tool_names: ["read"],
      permissions: ["workspace.read"],
      output_schema_ref: "rika.agent.task.v1",
      metadata: { product_profile: "Task", rika_reasoning_effort: "low" },
    })
    expect(explicit).not.toHaveProperty("preset_name")
  })

  it.effect("registers the deterministic agent, starts the deterministic execution, and converts text events", () =>
    Effect.gen(function* () {
      const streamEvents = [
        relayEvent("model.output.delta", 1, [
          Content.text("hello "),
          { type: "structured", value: { n: 1 } },
          Content.text("world"),
        ]),
        relayEvent("model.output.delta", 2, []),
        relayEvent("execution.completed", 3),
        relayEvent("model.output.delta", 4, [Content.text("ignored")]),
      ]
      const fixture = yield* makeClient({ startStatus: "queued", streamEvents })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 100 })
      }).pipe(provideBackendWithThreadTools(fixture.implementation))
      const registrations = yield* Ref.get(fixture.registrations)
      const starts = yield* Ref.get(fixture.starts)
      expect(yield* Ref.get(fixture.lookups)).toEqual([])
      expect(registrations[0]?.id).toBe("agent:rika")
      expect(registrations[0]?.address).toBe("address:rika")
      expect((starts[0] as { agent_revision?: number }).agent_revision).toBe(40)
      const registration = registrations[0]
      if (registration === undefined || !("instructions" in registration))
        return yield* Effect.die("Missing agent definition")
      expect((registration as { readonly tool_execution?: unknown }).tool_execution).toEqual({ concurrency: 4 })
      expect(registration.instructions).toContain("Consult Oracle frequently for complex or difficult tasks")
      expect(registration.instructions).toContain("tell the user that you are consulting it")
      expect(registration.instructions).toContain("after consulting Oracle, state that you did")
      expect(registration.instructions).toContain("remaining responsible for the implementation and conclusion")
      expect(registration.metadata).toMatchObject({ rika_agent_depth: 0 })
      expect(registration.metadata?.multi_agent_enabled).toBeUndefined()
      expect(registration.permissions).not.toContainEqual({ name: "relay.child_run.spawn", value: true })
      expect(registration.handoff_targets).toBeUndefined()
      expect(starts[0]).toMatchObject({
        root_address_id: "address:rika",
        session_id: "session:thread-a",
        agent_id: "agent:rika",
        idempotency_key: "turn-a",
        execution_id: "execution:turn-a",
        started_at: 100,
        completed_at: 100,
        input: [Content.text("prompt")],
      })
      expect(result.status).toBe("completed")
      expect(result.events).toEqual([
        {
          cursor: "cursor-1",
          sequence: 1,
          type: "model.output.delta",
          createdAt: 10,
          text: "hello world",
          content: [Content.text("hello "), { type: "structured", value: { n: 1 } }, Content.text("world")],
        },
        { cursor: "cursor-2", sequence: 2, type: "model.output.delta", createdAt: 20, content: [] },
        { cursor: "cursor-3", sequence: 3, type: "execution.completed", createdAt: 30 },
      ])
    }),
  )

  it.effect("isolates title executions in a tool-free auxiliary session", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-a",
          turnId: "title:turn-a",
          prompt: "title prompt",
          startedAt: 5,
          sessionPurpose: { _tag: "ThreadTitle", owningTurnId: "turn-a" },
        })
      }).pipe(provideBackendWithThreadTools(fixture.implementation))
      const registration = (yield* Ref.get(fixture.registrations))[0]
      if (registration === undefined || !("tools" in registration)) return yield* Effect.die("Missing agent definition")
      expect(registration.tools).toEqual([])
      expect(registration.permissions).toEqual([])
      expect(registration).not.toHaveProperty("child_run_presets")
      expect((yield* Ref.get(fixture.starts))[0]).toMatchObject({
        session_id: "session:aux:title:turn-a",
        idempotency_key: "title:turn-a",
        execution_id: "execution:title:turn-a",
      })
    }),
  )

  it.effect("maps distinct top-level Turn identities to distinct deterministic Relay identities", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [relayEvent("execution.completed", 1)],
        existingStatus: "running",
      })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "first", startedAt: 1 })
        yield* start(backend, {
          threadId: "session:thread-a",
          turnId: "execution:turn-a",
          prompt: "second",
          startedAt: 2,
        })
        yield* backend.inspect("execution:turn-a")
        yield* backend.replay("execution:turn-a")
        if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
        yield* backend.pageEvents("execution:turn-a", "forward")
        yield* backend.cancel("execution:turn-a", 3)
      }).pipe(provideBackendWithThreadTools(fixture.implementation))

      expect(yield* Ref.get(fixture.starts)).toMatchObject([
        {
          session_id: "session:thread-a",
          idempotency_key: "turn-a",
          execution_id: "execution:turn-a",
        },
        {
          session_id: "session:session:thread-a",
          idempotency_key: "execution:turn-a",
          execution_id: "execution:execution:turn-a",
        },
      ])
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:execution:turn-a", "execution:execution:turn-a"])
      expect((yield* Ref.get(fixture.replays)).map((input) => input.execution_id)).toEqual([
        "execution:execution:turn-a",
        "execution:execution:turn-a",
      ])
      expect((yield* Ref.get(fixture.pages)).map((input) => input.execution_id)).toEqual(["execution:execution:turn-a"])
      expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([
        "execution:execution:turn-a",
      ])
    }),
  )

  it.effect("keeps large execution results out of completed tracing spans", () =>
    Effect.gen(function* () {
      const streamEvents = [
        ...Array.from({ length: 4_000 }, (_, index) =>
          relayEvent("model.output.delta", index + 1, [Content.text(`chunk-${index}`)]),
        ),
        relayEvent("execution.completed", 4_001),
      ]
      const fixture = yield* makeClient({ streamEvents })
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const results = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
        })
        const followed = yield* backend.follow!("turn-a", undefined)
        return { started, followed }
      }).pipe(provideBackend(fixture.implementation), Effect.withTracer(tracer))
      expect(results.started.events).toHaveLength(4_001)
      expect(results.followed.events).toHaveLength(4_001)
      for (const name of ["ExecutionBackend.start", "ExecutionBackend.follow"]) {
        const span = spans.find((candidate) => candidate.name === name)
        expect(span?.status._tag).toBe("Ended")
        if (span?.status._tag !== "Ended") continue
        expect(Exit.isSuccess(span.status.exit)).toBe(true)
        if (!Exit.isSuccess(span.status.exit)) continue
        expect(typeof span.status.exit.value).toBe("undefined")
      }
    }),
  )

  it.effect("follows execution events while the durable start call is still running", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const running = relayEvent("tool.call.requested", 1, [], { tool_name: "bash", input: "sleep 20" })
      const completed = relayEvent("execution.completed", 2)
      const implementation: Client.Interface = {
        ...fixture.implementation,
        executions: {
          ...fixture.implementation.executions,
          startByAgentDefinition: (input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ execution_id: input.execution_id!, status: "completed" as const }),
            ),
          get: () =>
            Deferred.isDone(started).pipe(
              Effect.map((visible) =>
                visible
                  ? {
                      id: Ids.ExecutionId.make("execution:turn-a"),
                      root_address_id: Ids.AddressId.make("address:rika"),
                      status: "running" as const,
                      created_at: 1,
                      updated_at: 1,
                    }
                  : undefined,
              ),
            ),
          follow: () =>
            Stream.concat(
              Stream.fromEffect(Deferred.await(started).pipe(Effect.as({ _tag: "event" as const, event: running }))),
              Stream.fromEffect(Deferred.await(release).pipe(Effect.as({ _tag: "event" as const, event: completed }))),
            ),
        },
      }
      const seen: Array<string> = []
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* Effect.forkChild(
          start(backend, {
            threadId: "thread-a",
            turnId: "turn-a",
            prompt: "prompt",
            startedAt: 1,
            onEvent: (event) => seen.push(event.type),
          }),
        )
      }).pipe(provideBackend(implementation))
      yield* Effect.whileLoop({
        while: () => seen.length === 0,
        body: () => Effect.yieldNow,
        step: () => undefined,
      })
      expect(seen).toEqual(["tool.call.requested"])
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(result)).events.map((event) => event.type)).toEqual([
        "tool.call.requested",
        "execution.completed",
      ])
    }),
  )

  it.effect("emits safe correlated execution breadcrumbs without payloads", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [
          relayEvent("tool.call.requested", 1, [Content.text("SECRET_CONTENT")], { input: "SECRET_DATA" }),
          relayEvent("tool.result.received", 2, [Content.text("SECRET_RESULT")]),
          relayEvent("execution.completed", 3),
        ],
      })
      const lines: Array<string> = []
      const logger = Logger.make((options) => lines.push(Logger.formatJson.log(options)))
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-observed",
          turnId: "turn-observed",
          prompt: "SECRET_PROMPT",
          startedAt: 1,
        })
      }).pipe(provideConfiguredBackend(fixture.implementation, { selection }, Logger.layer([logger])))
      const records = yield* Effect.forEach(lines, (line) =>
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ message: Schema.String, annotations: Schema.Record(Schema.String, Schema.Unknown) }),
          ),
        )(line),
      )
      expect(records.map((record) => record.message)).toEqual([
        "execution.starting",
        "execution.accepted",
        "execution.follow.started",
        "execution.event.received",
        "execution.event.received",
        "execution.event.received",
        "execution.follow.completed",
      ])
      expect(records.find((record) => record.message === "execution.event.received")?.annotations).toMatchObject({
        "rika.execution.id": "execution:turn-observed",
        "rika.turn.id": "turn-observed",
        "rika.event.type": "tool.call.requested",
      })
      expect(lines.join("\n")).not.toContain("SECRET_")
    }),
  )

  it.effect("sends ordered image content to Relay and Baton", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-image",
          turnId: "turn-image",
          prompt: "before [Image 1] after",
          promptParts: [
            { type: "text", text: "before " },
            { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
            { type: "text", text: " after" },
          ],
          startedAt: 1,
        })
      }).pipe(provideBackend(fixture.implementation))
      expect((yield* Ref.get(fixture.starts))[0]?.input).toEqual([
        Content.text("before "),
        { type: "blob-reference", uri: "data:image/png;base64,cG5n", media_type: "image/png", filename: "shot.png" },
        Content.text(" after"),
      ])
    }),
  )

  it.effect.each(["execution.completed", "execution.failed", "execution.cancelled"] as const)(
    "terminates the start stream at %s",
    (type) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({ streamEvents: [relayEvent(type, 1), relayEvent("model.output.delta", 2)] })
        const result = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.events.map((value) => value.type)).toEqual([type])
      }),
  )

  it.effect("projects opaque Relay failure detail without discarding event data", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [
          relayEvent("execution.failed", 1, [], {
            message: "opaque provider failure",
            diagnostic: { retained: true },
          }),
        ],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(provideBackend(fixture.implementation))

      expect(result.events[0]).toMatchObject({
        type: "execution.failed",
        text: "opaque provider failure",
        data: { message: "opaque provider failure", diagnostic: { retained: true } },
      })
    }),
  )

  it.effect("prefers terminal failure content over Relay failure metadata", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [
          relayEvent("execution.failed", 1, [Content.text("content failure")], { message: "metadata failure" }),
        ],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(provideBackend(fixture.implementation))

      expect(result.events[0]?.text).toBe("content failure")
    }),
  )

  it.effect.each(["queued", "running"] as const)(
    "derives terminal completion after Relay starts with status %s",
    (status) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({ startStatus: status, streamEvents: [relayEvent("execution.completed", 1)] })
        const result = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.status).toBe("completed")
      }),
  )

  it.effect.each(["queued", "running"] as const)(
    "returns waiting when a %s execution reaches either actionable request",
    (startStatus) =>
      Effect.forEach(["permission.ask.requested", "tool.approval.requested"] as const, (actionableType) =>
        Effect.gen(function* () {
          const fixture = yield* makeClient({
            startStatus,
            streamEvents: [
              relayEvent("model.output.delta", 1),
              relayEvent(actionableType, 2, undefined, { wait_id: "wait:actionable" }),
            ],
            openWaitIds: ["wait:actionable"],
          })
          const seen: Array<string> = []
          const result = yield* Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            return yield* start(backend, {
              threadId: "thread-a",
              turnId: "turn-a",
              prompt: "prompt",
              startedAt: 1,
              onEvent: (item) => seen.push(item.type),
            })
          }).pipe(provideBackend(fixture.implementation))
          expect(result.status).toBe("waiting")
          expect(result.events.map((value) => value.type)).toEqual(["model.output.delta", actionableType])
          expect(seen).toEqual(["model.output.delta", actionableType])
        }),
      ),
  )

  it.effect.each(["completed", "failed", "cancelled"] as const)(
    "streams terminal executions started with status %s so events arrive incrementally",
    (status) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({
          startStatus: status,
          streamEvents: [
            relayEvent("model.output.delta", 1),
            relayEvent(`execution.${status}` as Execution.ExecutionEvent["type"], 2),
          ],
        })
        const seen: Array<string> = []
        const result = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* start(backend, {
            threadId: "thread-a",
            turnId: "turn-a",
            prompt: "prompt",
            startedAt: 1,
            onEvent: (item) => seen.push(item.type),
          })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.status).toBe(status)
        expect(result.events.map((value) => value.type)).toEqual(["model.output.delta", `execution.${status}`])
        expect(seen).toEqual(["model.output.delta", `execution.${status}`])
      }),
  )

  it.effect("uses the pinned current route instead of reselecting at start", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-variant",
          turnId: "turn-variant",
          prompt: "prompt",
          startedAt: 1,
          executionRoute: {
            ...currentExecutionRoute(),
            main: {
              ...currentExecutionRoute().main,
              effort: "xhigh",
              fast: true,
              registrationKey: "effort:xhigh:fast",
            },
          },
          reasoningEffort: "xhigh",
          fastMode: true,
        })
      }).pipe(provideBackend(fixture.implementation))
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
        | { model?: { registration_key?: string } }
        | undefined
      expect(registered?.model?.registration_key).toBe("effort:xhigh:fast")
      expect(RelayExecutionBackend.modelVariantKey("high", false)).toBe("effort:high")
    }),
  )

  it.effect("retains a fixed model selection when variants are unsupported", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-fixed",
          turnId: "turn-fixed",
          prompt: "prompt",
          startedAt: 1,
          reasoningEffort: "xhigh",
          fastMode: true,
        })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          modelVariantPolicy: "fixed-selection",
        }),
      )
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
        | { model?: { registration_key?: string } }
        | undefined
      expect(registered?.model).toEqual(selection)
      expect(registered?.model?.registration_key).toBeUndefined()
    }),
  )

  it.effect("registers compaction and permission policy options", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const permissionPolicy = [{ tool: "bash", action: "deny" }] as never
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const route = currentExecutionRoute()
        yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
          executionRoute: {
            ...route,
            main: {
              ...route.main,
              compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
            },
          },
        })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
          permissionPolicy,
        }),
      )
      expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({
        permission_rules: permissionPolicy,
        metadata: { steering_enabled: true },
        compaction_policy: {
          context_window: 10_000,
          reserve_tokens: 500,
          keep_recent_tokens: 2_000,
        },
      })
    }),
  )

  it.effect("resolves permission policy from the durable execution", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const permissionPolicy = { rules: [{ pattern: "bash", level: "deny" as const }] }
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          permissionPolicyForExecution: (executionId) =>
            executionId === "execution:turn-a"
              ? Effect.succeed(permissionPolicy)
              : Effect.fail(ExecutionBackend.BackendError.make({ message: "Unexpected execution" })),
        }),
      )
      expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({ permission_rules: permissionPolicy })
    }),
  )

  it.effect.each([
    ["execution.completed", "completed"],
    ["execution.failed", "failed"],
    ["execution.cancelled", "cancelled"],
    ["wait.created", "waiting"],
    ["model.output.delta", "running"],
  ] as const)("derives replay status %s as %s", ([type, status]) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ replayEvents: [relayEvent(type, 1)] })
      const results = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return [yield* backend.replay("turn-a"), yield* backend.replay("turn-a", "cursor-0")]
      }).pipe(provideBackend(fixture.implementation))
      const replays = yield* Ref.get(fixture.replays)
      expect(results.map((result) => result.status)).toEqual([status, status])
      expect(replays).toEqual([
        { execution_id: "execution:turn-a" },
        { execution_id: "execution:turn-a", after_cursor: "cursor-0" },
      ])
    }),
  )

  it.effect("uses the last Relay terminal event as authority despite stale late events", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        replayEvents: [
          relayEvent("execution.cancelled", 1),
          relayEvent("model.output.completed", 2),
          relayEvent("execution.failed", 3),
        ],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.replay("turn-a")
      }).pipe(provideBackend(fixture.implementation))
      expect(result.status).toBe("failed")
    }),
  )

  it.effect("pages execution events backward without using unbounded replay", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ pageEvents: [relayEvent("model.output.completed", 4)] })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
        return yield* backend.pageEvents("turn-a", "backward", "cursor-5", 200)
      }).pipe(provideBackend(fixture.implementation))
      expect(result).toMatchObject({
        events: [{ sequence: 4, type: "model.output.completed" }],
        hasMore: true,
        oldestCursor: "oldest",
        newestCursor: "newest",
      })
      expect(yield* Ref.get(fixture.pages)).toEqual([
        {
          execution_id: "execution:turn-a",
          direction: "backward",
          before_cursor: "cursor-5",
          limit: 200,
        },
      ])
      expect(yield* Ref.get(fixture.replays)).toEqual([])
    }),
  )

  it.effect("cancels with deterministic payload and returns the accepted status and replayed events", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        existingStatus: "running",
        cancelStatus: "queued",
        replayEvents: [relayEvent("execution.cancelled", 1)],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.cancel("turn-a", 50)
      }).pipe(provideBackend(fixture.implementation))
      expect(yield* Ref.get(fixture.cancellations)).toEqual([{ execution_id: "execution:turn-a", cancelled_at: 50 }])
      expect(result.status).toBe("queued")
      expect(result.events.map((value) => value.type)).toEqual(["execution.cancelled"])
    }),
  )

  it.effect("waits for a concurrently starting execution before cancelling", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        existingStatus: "running",
        unavailableLookups: 2,
        cancelStatus: "cancelled",
        replayEvents: [relayEvent("execution.cancelled", 1)],
      })
      const cancellation = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.cancel("turn-a", 50)
      }).pipe(provideBackend(fixture.implementation), Effect.forkChild)
      yield* TestClock.adjust("50 millis")
      const result = yield* Fiber.join(cancellation)
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a", "execution:turn-a", "execution:turn-a"])
      expect(yield* Ref.get(fixture.cancellations)).toEqual([{ execution_id: "execution:turn-a", cancelled_at: 50 }])
      expect(result.status).toBe("cancelled")
    }),
  )

  it.effect.each(["replay", "cancel"] as const)("maps %s client failures to BackendError", (operation) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        fail: operation,
        ...(operation === "cancel" ? { existingStatus: "running" as const } : {}),
      })
      const failure = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (operation === "replay") return yield* Effect.flip(backend.replay("turn-a"))
        return yield* Effect.flip(backend.cancel("turn-a", 2))
      }).pipe(provideBackend(fixture.implementation))
      expect(failure._tag).toBe("ExecutionBackendError")
      expect(failure.message).toContain(`${operation} failed`)
    }),
  )

  it.effect("retries an unknown start outcome with the exact durable identity", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const attempts = yield* Ref.make(0)
      const implementation: Client.Interface = {
        ...fixture.implementation,
        executions: {
          ...fixture.implementation.executions,
          startByAgentDefinition: (input) =>
            Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 0
                  ? Ref.update(fixture.starts, (values) => [...values, input]).pipe(
                      Effect.andThen(Effect.fail(clientFailure("start outcome unknown"))),
                    )
                  : fixture.implementation.executions.startByAgentDefinition(input),
              ),
            ),
        },
      }
      const resultFiber = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
        })
      }).pipe(provideBackend(implementation), Effect.forkChild)

      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(resultFiber)
      const starts = yield* Ref.get(fixture.starts)
      expect(result.status).toBe("completed")
      expect(starts).toHaveLength(2)
      expect(starts[1]).toEqual(starts[0])
      expect(starts[0]).toMatchObject({
        execution_id: "execution:turn-a",
        idempotency_key: "turn-a",
      })
    }),
  )

  it.effect("keeps waiting when durable acceptance is not visible after fifteen seconds", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const visible = yield* Ref.make(false)
      const implementation: Client.Interface = {
        ...fixture.implementation,
        executions: {
          ...fixture.implementation.executions,
          startByAgentDefinition: () => Effect.never,
          get: () =>
            Ref.get(visible).pipe(
              Effect.map((accepted) =>
                accepted
                  ? {
                      id: Ids.ExecutionId.make("execution:turn-a"),
                      root_address_id: Ids.AddressId.make("address:rika"),
                      status: "running" as const,
                      created_at: 1,
                      updated_at: 1,
                    }
                  : undefined,
              ),
            ),
        },
      }
      const resultFiber = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
        })
      }).pipe(provideBackend(implementation), Effect.forkChild)

      yield* TestClock.adjust("16 seconds")
      expect(resultFiber.pollUnsafe()).toBeUndefined()
      yield* Ref.set(visible, true)
      yield* TestClock.adjust("25 millis")
      expect((yield* Fiber.join(resultFiber)).status).toBe("completed")
    }),
  )

  it.effect("recovers a canonical terminal execution when start fails after persistence", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        fail: "start",
        existingStatus: "failed",
        streamEvents: [
          relayEvent("permission.ask.requested", 1, undefined, { wait_id: "wait:resolved" }),
          relayEvent("permission.ask.resolved", 2, undefined, { wait_id: "wait:resolved", approved: true }),
          relayEvent("execution.failed", 3, [], { message: "canonical failure" }),
          relayEvent("model.output.delta", 4, [Content.text("ignored")]),
        ],
        openWaitIds: ["wait:unrelated"],
      })
      const seen: Array<string> = []
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
          onEvent: (item) => seen.push(item.type),
        })
      }).pipe(provideBackend(fixture.implementation))

      expect(yield* Ref.get(fixture.starts)).toHaveLength(1)
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a"])
      expect(yield* Ref.get(fixture.replays)).toEqual([])
      expect(result.status).toBe("failed")
      expect(result.events.map((item) => item.type)).toEqual([
        "permission.ask.requested",
        "permission.ask.resolved",
        "execution.failed",
      ])
      expect(result.events[2]).toMatchObject({ text: "canonical failure", data: { message: "canonical failure" } })
      expect(seen).toEqual(["permission.ask.requested", "permission.ask.resolved", "execution.failed"])
    }),
  )

  it.effect("recovers a canonical terminal execution when streaming fails after completion", () =>
    Effect.gen(function* () {
      const output = relayEvent("model.output.completed", 1, [Content.text("answer")])
      const completed = relayEvent("execution.completed", 2, [], { model_output: "answer" })
      const fixture = yield* makeClient({
        existingStatus: "completed",
        streamEvents: [output],
        streamFailure: "effect/sql/SqlError: Failed to execute statement",
        replayEvents: [output, completed],
      })
      const seen: Array<string> = []
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
          onEvent: (item) => seen.push(item.type),
        })
      }).pipe(provideBackend(fixture.implementation))

      expect(result.status).toBe("completed")
      expect(result.events.map((item) => item.type)).toEqual(["model.output.completed", "execution.completed"])
      expect(seen).toEqual(["model.output.completed", "execution.completed"])
      expect(yield* Ref.get(fixture.lookups)).toEqual([])
      expect(yield* Ref.get(fixture.replays)).toEqual([])
    }),
  )

  it.effect("preserves the start failure when reconciliation lookup fails", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ fail: "lookup" })
      const implementation: Client.Interface = {
        ...fixture.implementation,
        executions: {
          ...fixture.implementation.executions,
          startByAgentDefinition: () => Effect.fail(clientFailure("start failed")),
        },
      }
      const failure = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* Effect.flip(
          start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 }),
        )
      }).pipe(provideBackend(implementation))

      expect(failure.message).toContain("start failed")
      expect(failure.message).not.toContain("lookup failed")
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a"])
    }),
  )

  it.effect("does not reconcile registration failures", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ fail: "register" })
      const failure = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* Effect.flip(
          start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 }),
        )
      }).pipe(provideBackend(fixture.implementation))

      expect(failure.message).toContain("register failed")
      expect(yield* Ref.get(fixture.starts)).toEqual([])
      expect(yield* Ref.get(fixture.lookups)).toEqual([])
    }),
  )

  it.effect("adapts fan-out, workflow, child, inspection, steering, and approval operations", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const calls: Array<[string, unknown]> = []
      const fanOut = {
        fan_out_id: "fan-1",
        parent_execution_id: "execution:parent-1",
        state: "running",
        max_concurrency: 2,
        join: { _tag: "quorum", count: 1 },
        members: [
          { child_execution_id: "child:one", ordinal: 0, state: "completed", output: "done" },
          { child_execution_id: "child:two", ordinal: 1, state: "failed", error: "bad" },
        ],
      }
      const workflow = {
        execution_id: "workflow:run-1",
        pin: {
          workflow_definition_id: "rika:delivery:v1",
          workflow_definition_revision: 2,
          workflow_definition_digest: "digest",
        },
        status: "running",
        created_at: 10,
        updated_at: 20,
      }
      Object.assign(fixture.implementation.childRuns, {
        createFanOut: (input: unknown) => (calls.push(["createFanOut", input]), Effect.succeed(fanOut)),
        inspectFanOut: (input: unknown) => (calls.push(["inspectFanOut", input]), Effect.succeed({ fan_out: fanOut })),
        cancelFanOut: (input: unknown) => (calls.push(["cancelFanOut", input]), Effect.succeed({ fan_out: fanOut })),
        spawn: (input: unknown) => (calls.push(["child", input]), Effect.succeed({})),
      })
      Object.assign(fixture.implementation.workflows, {
        registerDefinition: (input: { definition: { name: string } }) =>
          Effect.succeed({
            record: { definition: input.definition, revision: 1, digest: `digest-${input.definition.name}` },
          }),
        startRun: (input: unknown) => (calls.push(["startWorkflow", input]), Effect.succeed(workflow)),
        inspectRun: (input: unknown) => (calls.push(["inspectWorkflow", input]), Effect.succeed(workflow)),
        cancelRun: (input: unknown) => (calls.push(["cancelWorkflow", input]), Effect.succeed(workflow)),
      })
      Object.assign(fixture.implementation.executions, {
        get: () =>
          Effect.succeed({
            status: "waiting",
            agent_snapshot: {
              model: { provider: "test", model: "scripted", registration_key: "fixed" },
              metadata: { rika_execution_route: currentExecutionRoute() },
            },
          }),
        inspect: () =>
          Effect.succeed({
            status: "waiting",
            last_event_cursor: "last",
            waiting_on: [{ wait_id: "wait-1", mode: "external", created_at: 1 }],
            pending_tool_calls: [
              { tool_call_id: "call-1", tool_name: "bash", input: { command: "pwd" }, requested_at: 2 },
            ],
            child_runs: [{ child_execution_id: "child:one", status: "completed" }],
          }),
        steer: (input: unknown) => (calls.push(["steer", input]), Effect.succeed({})),
      })
      Object.assign(fixture.implementation.tools, {
        listPendingApprovals: () =>
          Effect.succeed({
            approvals: [{ wait_id: "wait-1", tool_call_id: "call-1", tool_name: "bash", input: {}, requested_at: 3 }],
          }),
        resolveApproval: (input: unknown) => (calls.push(["approval", input]), Effect.succeed({})),
        resolvePermission: (input: unknown) => (calls.push(["permission", input]), Effect.succeed({})),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return {
          fan: yield* createFanOut(backend, {
            fanOutId: "fan-1",
            parentTurnId: "parent-1",
            children: [
              { childId: "one", prompt: "a", profile: "Oracle" },
              { childId: "two", prompt: "b" },
            ],
            maxConcurrency: 2,
            join: "quorum",
            quorum: 1,
            createdAt: 1,
          }),
          inspectedFan: yield* backend.inspectFanOut("fan-1"),
          cancelledFan: yield* backend.cancelFanOut("fan-1", 4, "stop"),
          registrations: yield* backend.registerWorkflows(),
          startedWorkflow: yield* backend.startWorkflow("delivery", "run-1", 2),
          inspectedWorkflow: yield* backend.inspectWorkflow("run-1"),
          cancelledWorkflow: yield* backend.cancelWorkflow("run-1"),
          child: yield* backend.invokeChild({
            parentTurnId: "parent-1",
            childId: "one",
            profile: "Task",
            prompt: "work",
          }),
          inspection: yield* backend.inspect("parent-1"),
          approvals: yield* backend.listApprovals("parent-1"),
          steer: yield* backend.steer("parent-1", "continue", 5),
          approval: yield* backend.resolveToolApproval("wait-1", true, 6, "ok"),
          permission: yield* backend.resolvePermission("wait-1", "Approved", 7, "safe"),
        }
      }).pipe(provideBackend(fixture.implementation))
      expect(result.fan).toMatchObject({ fanOutId: "fan-1", parentTurnId: "parent-1", join: "quorum" })
      expect(result.fan.members).toEqual([
        { childId: "one", ordinal: 0, state: "completed", output: "done" },
        { childId: "two", ordinal: 1, state: "failed", error: "bad" },
      ])
      expect(result.registrations.map((value) => value.name)).toEqual(["delivery", "research-synthesis"])
      expect(result.startedWorkflow).toMatchObject({ runId: "run-1", workflow: "delivery", revision: 2 })
      expect(result.child).toEqual({ parentTurnId: "parent-1", childId: "one", profile: "Task", type: "accepted" })
      expect(result.inspection).toMatchObject({ status: "waiting", lastCursor: "last" })
      expect(result.approvals[0]).toMatchObject({ waitId: "wait-1", callId: "call-1" })
      expect(calls).toHaveLength(10)
    }),
  )

  it.effect("covers absent optional adapter results and payload fields", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const calls: Array<unknown> = []
      Object.assign(fixture.implementation.childRuns, {
        inspectFanOut: () => Effect.succeed({ fan_out: null }),
        cancelFanOut: (input: unknown) => {
          calls.push(input)
          return Effect.succeed({
            fan_out: {
              fan_out_id: "fan",
              parent_execution_id: "child:parent",
              state: "cancelled",
              max_concurrency: 1,
              join: { _tag: "all" },
              members: [],
            },
          })
        },
      })
      Object.assign(fixture.implementation.workflows, {
        inspectRun: () => Effect.void,
        cancelRun: () => Effect.void,
        startRun: (input: unknown) => {
          calls.push(input)
          return Effect.succeed({
            execution_id: "workflow:r",
            pin: {
              workflow_definition_id: "rika:research-synthesis:v1",
              workflow_definition_revision: 1,
              workflow_definition_digest: "d",
            },
            status: "queued",
            created_at: 1,
            updated_at: 1,
          })
        },
      })
      Object.assign(fixture.implementation.executions, { get: () => Effect.void })
      Object.assign(fixture.implementation.tools, {
        resolveApproval: (input: unknown) => (calls.push(input), Effect.succeed({})),
        resolvePermission: (input: unknown) => (calls.push(input), Effect.succeed({})),
      })
      const values = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return [
          yield* backend.inspectFanOut("missing"),
          yield* backend.cancelFanOut("fan", 1),
          yield* backend.startWorkflow("research-synthesis", "r"),
          yield* backend.inspectWorkflow("r"),
          yield* backend.cancelWorkflow("r"),
          yield* backend.inspect("missing"),
          yield* backend.resolveToolApproval("wait", false, 2),
          yield* backend.resolvePermission("wait", "Denied", 3),
        ]
      }).pipe(provideBackend(fixture.implementation))
      expect(values[0]).toBeUndefined()
      expect(values[1]).toMatchObject({ parentTurnId: "child:parent", join: "all" })
      expect(values[3]).toBeUndefined()
      expect(values[4]).toBeUndefined()
      expect(values[5]).toBeUndefined()
      expect(calls).toContainEqual({ fan_out_id: "fan", cancelled_at: 1 })
      expect(calls).toContainEqual({ wait_id: "wait", approved: false, resolved_at: 2 })
      expect(calls).toContainEqual({ wait_id: "wait", answer: "Denied", resolved_at: 3 })
    }),
  )

  it.effect("covers every join payload and child-prefixed execution identifiers", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        replayEvents: [relayEvent("model.output.delta", 1, [{ type: "text", text: "" }])],
      })
      const inputs: Array<unknown> = []
      Object.assign(fixture.implementation.childRuns, {
        createFanOut: (input: unknown) => {
          inputs.push(input)
          return Effect.succeed({
            fan_out_id: "fan",
            parent_execution_id: "execution:p",
            state: "running",
            max_concurrency: 1,
            join: { _tag: "all" },
            members: [],
          })
        },
      })
      Object.assign(fixture.implementation.executions, {
        get: () => Effect.succeed({ status: "running" }),
        inspect: () => Effect.succeed({ status: "running", waiting_on: [], pending_tool_calls: [], child_runs: [] }),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        for (const join of ["all", "first-success", "best-effort"] as const) {
          yield* createFanOut(backend, {
            fanOutId: `fan-${join}`,
            parentTurnId: "p",
            children: [],
            maxConcurrency: 1,
            join,
            createdAt: 1,
          })
        }
        yield* createFanOut(backend, {
          fanOutId: "fan-quorum-default",
          parentTurnId: "p",
          children: [],
          maxConcurrency: 1,
          join: "quorum",
          createdAt: 1,
        })
        return {
          replay: yield* backend.replay("child:already-prefixed", undefined, ExecutionBackend.executionReference),
          inspection: yield* backend.inspect("p"),
        }
      }).pipe(provideBackend(fixture.implementation))
      expect(inputs).toHaveLength(4)
      expect(result.replay.events[0]).not.toHaveProperty("text")
      expect(result.inspection).not.toHaveProperty("lastCursor")
    }),
  )

  it.effect("round-trips every inspected child execution identifier through execution operations", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ cancelStatus: "cancelled" })
      const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Review:call-review")
      Object.assign(fixture.implementation.executions, {
        get: () => Effect.succeed({ status: "running" }),
        inspect: () =>
          Effect.succeed({
            status: "running",
            waiting_on: [],
            pending_tool_calls: [],
            child_runs: [{ child_execution_id: childExecutionId, status: "running" }],
          }),
      })
      const inspectedChildId = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const inspection = yield* backend.inspect("parent")
        const childId = inspection?.children[0]?.executionId
        if (childId === undefined) return yield* Effect.die("Missing inspected child")
        yield* backend.replay(childId, undefined, ExecutionBackend.executionReference)
        if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
        yield* backend.pageEvents(childId, "forward", undefined, undefined, ExecutionBackend.executionReference)
        yield* backend.cancel(childId, 10, ExecutionBackend.executionReference)
        return childId
      }).pipe(provideBackend(fixture.implementation))

      expect(inspectedChildId).toBe(childExecutionId)
      expect((yield* Ref.get(fixture.replays)).map((input) => input.execution_id)).toEqual([
        childExecutionId,
        childExecutionId,
      ])
      expect((yield* Ref.get(fixture.pages)).map((input) => input.execution_id)).toEqual([childExecutionId])
      expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([childExecutionId])
    }),
  )

  it.effect("follows only the selected execution when the event scope is execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeClient()
        const rootExecutionId = Ids.ExecutionId.make("execution:parent")
        const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Task:call-task")
        const followed = yield* Ref.make<ReadonlyArray<string>>([])
        Object.assign(fixture.implementation.executions, {
          inspect: (id: Ids.ExecutionId) =>
            Effect.succeed({
              status: "running",
              waiting_on: [],
              pending_tool_calls: [],
              child_runs: id === rootExecutionId ? [{ child_execution_id: childExecutionId, status: "running" }] : [],
            }),
          follow: (input: { readonly execution_id: Ids.ExecutionId }) =>
            Stream.fromEffect(
              Ref.update(followed, (executionIds) => [...executionIds, String(input.execution_id)]),
            ).pipe(Stream.concat(Stream.never)),
        })

        const follower = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
          return yield* Effect.forkChild(backend.follow("parent", undefined, undefined, undefined, "execution"))
        }).pipe(provideBackend(fixture.implementation))
        while ((yield* Ref.get(followed)).length === 0) yield* Effect.yieldNow
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow

        expect(yield* Ref.get(followed)).toEqual([rootExecutionId])
        yield* Fiber.interrupt(follower)
      }),
    ),
  )

  it.effect("surfaces nested child permission asks and approvals through the parent execution", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const rootExecutionId = Ids.ExecutionId.make("execution:parent")
      const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Review:call-review")
      const spawned = {
        ...relayEvent("child_run.spawned", 1, undefined, { child_execution_id: childExecutionId }),
        execution_id: rootExecutionId,
        child_execution_id: childExecutionId,
      }
      const requested = {
        ...relayEvent("permission.ask.requested", 1, undefined, {
          wait_id: "wait-child",
          tool_call_id: "call-child",
          tool_name: "read",
        }),
        execution_id: Ids.ExecutionId.make(childExecutionId),
      }
      Object.assign(fixture.implementation.executions, {
        inspect: (id: Ids.ExecutionId) =>
          Effect.succeed(
            id === rootExecutionId
              ? {
                  status: "waiting",
                  waiting_on: [],
                  pending_tool_calls: [],
                  child_runs: [{ child_execution_id: childExecutionId, status: "waiting" }],
                }
              : {
                  status: "waiting",
                  waiting_on: [
                    {
                      wait_id: "wait-child",
                      execution_id: childExecutionId,
                      mode: "reply",
                      state: "open",
                      metadata: {},
                      created_at: 2,
                    },
                  ],
                  pending_tool_calls: [],
                  child_runs: [],
                },
          ),
        follow: (input: { readonly execution_id: Ids.ExecutionId }) =>
          Stream.fromIterable(
            (input.execution_id === rootExecutionId ? [spawned] : [requested]).map((event) => ({
              _tag: "event" as const,
              event,
            })),
          ),
      })
      Object.assign(fixture.implementation.tools, {
        listPendingApprovals: (input: { readonly execution_id: Ids.ExecutionId }) =>
          Effect.succeed({
            approvals:
              String(input.execution_id) === String(childExecutionId)
                ? [
                    {
                      wait_id: "approval-child",
                      execution_id: childExecutionId,
                      tool_call_id: "call-approval-child",
                      tool_name: "bash",
                      input: { command: "pwd" },
                      requested_at: 3,
                    },
                  ]
                : [],
          }),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
        return {
          followed: yield* backend.follow("parent", undefined),
          approvals: yield* backend.listApprovals("parent"),
        }
      }).pipe(provideBackend(fixture.implementation))

      expect(result.followed.status).toBe("waiting")
      expect(result.followed.events.find((event) => event.type === "permission.ask.requested")?.data).toMatchObject({
        wait_id: "wait-child",
        execution_id: childExecutionId,
      })
      expect(result.approvals).toEqual([
        {
          waitId: "approval-child",
          executionId: childExecutionId,
          callId: "call-approval-child",
          toolName: "bash",
          input: { command: "pwd" },
          requestedAt: 3,
        },
      ])
    }),
  )

  it.effect("durably carries workspace, route, token budget, and compaction through fan-out", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const fanOutInputs: Array<any> = []
      Object.assign(fixture.implementation.childRuns, {
        createFanOut: (input: any) => {
          fanOutInputs.push(input)
          return Effect.succeed({
            fan_out_id: input.fan_out_id,
            parent_execution_id: input.parent_execution_id,
            state: "running",
            max_concurrency: input.max_concurrency,
            join: input.join,
            members: [],
          })
        },
      })
      const oracleSelection = {
        provider: "oracle-provider",
        model: "oracle-model",
        registrationKey: "sol:high:normal",
      }
      const taskSelection = {
        provider: "task-provider",
        model: "task-model",
        registrationKey: "terra:medium:normal",
      }
      const summarySelection = {
        provider: "summary-provider",
        model: "summary-model",
        registrationKey: "terra:low:normal",
      }
      const mainCompaction = { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 }
      const oracleCompaction = { contextWindow: 1_000_000, reserveTokens: 128_000, keepRecentTokens: 64_000 }
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const route = {
          mode: "test" as const,
          compactionSummary: routeFor("compaction", summarySelection, mainCompaction),
          main: routeFor("main", selection, mainCompaction),
          oracle: routeFor("oracle", oracleSelection, oracleCompaction),
          agents: {
            librarian: routeFor("librarian", selection, mainCompaction),
            painter: routeFor("painter", selection, mainCompaction),
            review: routeFor("review", selection, mainCompaction),
            readThread: routeFor("readThread", selection, mainCompaction),
            task: routeFor("task", taskSelection, mainCompaction),
          },
        }
        yield* start(backend, {
          threadId: "thread",
          turnId: "other-turn",
          prompt: "prompt",
          startedAt: 1,
          executionRoute: route,
        })
        yield* createFanOut(backend, {
          fanOutId: "fan",
          parentTurnId: "turn",
          workspace: "/client/workspace",
          executionRoute: route,
          children: [
            { childId: "oracle", profile: "Oracle", prompt: "inspect" },
            { childId: "task", profile: "Task", prompt: "work" },
          ],
          maxConcurrency: 2,
          join: "all",
          createdAt: 2,
        })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          oracleSelection,
          compaction: mainCompaction,
          oracleCompaction,
          resolveWorkspace: (execution) => Effect.succeed(execution.includes("other-turn") ? "/configured" : "/plain"),
          webSearchCredentialsForWorkspace: (workspace) =>
            Effect.succeed(workspace === "/configured" ? { parallel: Redacted.make("secret") } : {}),
        }),
      )
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as any
      expect(registered.model).toEqual({
        provider: selection.provider,
        model: selection.model,
        registration_key: "default",
      })
      expect(registered.compaction_policy).toEqual({
        context_window: 372_000,
        reserve_tokens: 128_000,
        keep_recent_tokens: 32_000,
        summary_model: {
          provider: "summary-provider",
          model: "summary-model",
          registration_key: "terra:low:normal",
        },
      })
      expect(registered.child_run_presets.Task).toMatchObject({
        model: {
          provider: selection.provider,
          model: selection.model,
          registration_key: "default",
          metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
        },
        metadata: { product_profile: "Task", rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      })
      expect(registered.child_run_presets.Task.tool_names).toContain("web_search")
      expect(registered.child_run_presets.Oracle).toMatchObject({
        model: {
          provider: oracleSelection.provider,
          model: oracleSelection.model,
          registration_key: oracleSelection.registrationKey,
          metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
        },
      })
      const oraclePolicy = {
        context_window: 1_000_000,
        reserve_tokens: 128_000,
        keep_recent_tokens: 64_000,
        summary_model: {
          provider: "summary-provider",
          model: "summary-model",
          registration_key: "terra:low:normal",
        },
      }
      expect(fanOutInputs[0].children[0].override.model).toMatchObject({
        provider: oracleSelection.provider,
        model: oracleSelection.model,
        registration_key: oracleSelection.registrationKey,
        metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      })
      expect(fanOutInputs[0].children[0].override.compaction_policy).toEqual(oraclePolicy)
      expect(fanOutInputs[0].children[0].override.tool_names).not.toContain("web_search")
      expect(fanOutInputs[0].children[0].override.tool_names).not.toContain("read_web_page")
      expect(fanOutInputs[0].children[1].override.model).toMatchObject({
        provider: taskSelection.provider,
        model: taskSelection.model,
        registration_key: taskSelection.registrationKey,
        metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      })
      expect(fanOutInputs[0].children[1].override.compaction_policy).toEqual(registered.compaction_policy)
      expect(fanOutInputs[0].children[0].metadata).toMatchObject({
        rika_workspace: "/client/workspace",
      })
      expect(fanOutInputs[0].children[0].metadata.rika_execution_route).toEqual({
        mode: "test",
        compactionSummary: routeFor("compaction", summarySelection, mainCompaction),
        main: routeFor("main", selection, mainCompaction),
        oracle: routeFor("oracle", oracleSelection, oracleCompaction),
        agents: {
          librarian: routeFor("librarian", selection, mainCompaction),
          painter: routeFor("painter", selection, mainCompaction),
          review: routeFor("review", selection, mainCompaction),
          readThread: routeFor("readThread", selection, mainCompaction),
          task: routeFor("task", taskSelection, mainCompaction),
        },
      })
    }),
  )

  it("gates web tools by configured provider credentials", () => {
    const unavailable = RelayExecutionBackend.toolkitFor({})
    expect(Object.keys(unavailable.tools)).not.toContain("web_search")
    expect(Object.keys(unavailable.tools)).not.toContain("read_web_page")

    const unsupported = RelayExecutionBackend.toolkitFor({
      webSearchCredentials: { custom: Redacted.make("custom") },
    })
    expect(Object.keys(unsupported.tools)).not.toContain("web_search")

    const exa = RelayExecutionBackend.toolkitFor({
      webSearchCredentials: { exa: Redacted.make("exa") },
    })
    expect(Object.keys(exa.tools)).toContain("web_search")
    expect(Object.keys(exa.tools)).not.toContain("read_web_page")

    const parallel = RelayExecutionBackend.toolkitFor({
      webSearchCredentials: { parallel: Redacted.make("parallel") },
    })
    expect(Object.keys(parallel.tools)).toContain("web_search")
    expect(Object.keys(parallel.tools)).toContain("read_web_page")
  })

  it("composes supported provider factories and reports unknown IDs", () => {
    const configured = RelayExecutionBackend.webSearchFactories({
      exa: Redacted.make("exa"),
      github: Redacted.make("github"),
      custom: Redacted.make("custom"),
    })
    expect(configured.factories).toHaveLength(2)
    expect(configured.unsupportedIds).toEqual(["custom"])
  })

  it.effect("ensures the thread host entity and notifies it through the durable inbox", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const kinds: Array<unknown> = []
      const sent: Array<Record<string, unknown>> = []
      Object.assign(fixture.implementation.residents, {
        registerKind: (input: unknown) =>
          Effect.sync(() => {
            kinds.push(input)
            return input
          }),
        spawn: (input: { readonly key: string }) =>
          Effect.succeed({
            kind: "rika-thread",
            key: input.key,
            address_id: `address:entity:${input.key}`,
            execution_id: `execution:entity:${input.key}`,
            generation: 0,
            status: "active",
            created_at: 1,
          }),
        get: (input: { readonly key: string }) =>
          Effect.succeed({
            kind: "rika-thread",
            key: input.key,
            address_id: `address:entity:${input.key}`,
            execution_id: `execution:entity:${input.key}`,
            generation: 0,
            status: "active",
            created_at: 1,
          }),
      })
      Object.assign(fixture.implementation.executions, {
        inspect: (executionId: string) =>
          Effect.succeed({
            execution_id: executionId,
            status: "waiting",
            waiting_on: [{ wait_id: "wait:inbox:host", mode: "event", created_at: 1 }],
            pending_tool_calls: [],
            child_runs: [],
          }),
      })
      Object.assign(fixture.implementation.envelopes, {
        send: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            sent.push(input)
            return { envelope_id: "envelope:notify", execution_id: `execution:entity:thread-a` }
          }),
      })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.wakeThreadHost!({ threadId: "thread-a", generation: 9, queueRevision: 12, now: 102 })
        yield* backend.wakeThreadHost!({ threadId: "thread-a", generation: 9, queueRevision: 12, now: 103 })
        yield* backend.registerTurnPromoter!(() => Effect.succeed(1))
      }).pipe(provideBackend(fixture.implementation))
      const registrations = yield* Ref.get(fixture.registrations)
      expect(registrations[0]?.id).toBe("agent:rika-thread-host")
      const registration = registrations[0]
      if (registration === undefined || !("model" in registration)) return yield* Effect.die("Missing host agent")
      expect(registration.model).toEqual({ provider: "rika", model: "thread-host" })
      expect(registration.max_wait_turns).toBe(1_000_000)
      expect(registration.metadata?.steering_enabled).toBe(false)
      expect(kinds).toEqual([
        {
          kind: "rika-thread",
          agent_id: "agent:rika-thread-host",
          inbox: { drain: "all" },
          state_enabled: false,
          continue_as_new_after_turns: 32,
          metadata: { product: "rika" },
        },
      ])
      expect(sent).toHaveLength(2)
      expect(sent[0]).toMatchObject({
        from: "address:rika",
        to: "address:entity:thread-a",
        idempotency_key: "rika:queue-wake:thread-a:9",
      })
      expect(
        yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
          (sent[0]!.content as Array<{ text: string }>)[0]!.text,
        ),
      ).toEqual({
        kind: "queue-ready",
        thread_id: "thread-a",
        wake_generation: 9,
        queue_revision: 12,
      })
      expect(sent[1]).toMatchObject({ idempotency_key: "rika:queue-wake:thread-a:9" })
    }),
  )

  it.effect("recreates an active thread host whose execution is terminal before get-or-create", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const calls: Array<string> = []
      const failed = {
        kind: "rika-thread",
        key: "thread-stale",
        address_id: "address:entity:thread-stale",
        execution_id: "execution:entity:thread-stale:0",
        generation: 0,
        status: "active" as const,
        created_at: 1,
      }
      const recreated = { ...failed, execution_id: "execution:entity:thread-stale:1", generation: 1 }
      Object.assign(fixture.implementation.residents, {
        registerKind: (input: unknown) => Effect.succeed(input),
        get: () => Effect.sync(() => (calls.push("get"), failed)),
        destroy: () => Effect.sync(() => (calls.push("destroy"), { ...failed, status: "destroyed" })),
        spawn: () => Effect.sync(() => (calls.push("create"), recreated)),
      })
      Object.assign(fixture.implementation.executions, {
        inspect: (executionId: string) =>
          Effect.sync(() => {
            calls.push("inspect")
            return {
              execution_id: executionId,
              status: executionId === failed.execution_id ? "failed" : "waiting",
              waiting_on:
                executionId === failed.execution_id ? [] : [{ wait_id: "wait:host", mode: "event", created_at: 1 }],
              pending_tool_calls: [],
              child_runs: [],
            }
          }),
      })
      Object.assign(fixture.implementation.envelopes, {
        send: () => Effect.succeed({ envelope_id: "envelope:wake", execution_id: recreated.execution_id }),
      })

      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.wakeThreadHost!({ threadId: "thread-stale", generation: 1, queueRevision: 1, now: 100 })
      }).pipe(provideBackend(fixture.implementation))

      expect(calls).toEqual(["get", "inspect", "destroy", "create", "inspect"])
    }),
  )

  it.effect("constructs the public runtime layer lazily", () =>
    Effect.gen(function* () {
      const model = yield* TestModel.make([])
      expect(
        RelayExecutionBackend.layer({
          filename: ":memory:",
          workspace: "/tmp",
          registration: model.registration,
          selection: model.selection,
        }),
      ).toBeDefined()
    }),
  )

  it.effect.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "builds the runtime layer with resilience=%s and extension handlers=%s",
    ([resilience, extensions]: readonly [boolean, boolean]) =>
      Effect.gen(function* () {
        const model = yield* TestModel.make([])
        const fixture = yield* makeClient({
          replayEvents: [
            relayEvent("model.output.completed", 1, [Content.text("fallback")]),
            relayEvent("execution.completed", 2, [Content.text("done")]),
          ],
          streamEvents: [
            relayEvent("model.output.completed", 1, [Content.text("fallback")]),
            relayEvent("execution.completed", 2, [Content.text("done")]),
          ],
        })
        Object.assign(fixture.implementation.executions, { get: () => Effect.succeed({ status: "completed" }) })
        Object.assign(fixture.implementation.childRuns, {
          spawn: () => Effect.succeed({}),
          createFanOut: (definition: unknown) => Effect.succeed(definition),
          inspectFanOut: () => Effect.succeed({ fan_out: null }),
        })
        native.client = fixture.implementation
        native.databaseAcquisitions = 0
        native.runtimeGraphs = 0
        const result = yield* RelayExecutionBackend.layer({
          filename: ":memory:",
          workspace: "/tmp",
          registration: model.registration,
          selection: model.selection,
          ...(resilience ? { modelResilience: ModelResilience.make({ retrySchedule: Schedule.recurs(0) }) } : {}),
          ...(extensions ? { additionalToolkit: Toolkit.make(), additionalHandlerLayer: Layer.empty } : {}),
        }).pipe(Layer.provide(BunServices.layer), Layer.build, Effect.exit)
        expect(result._tag).toBe("Success")
        expect(native.databaseAcquisitions).toBe(1)
        expect(native.runtimeGraphs).toBe(1)
      }),
  )

  it.effect("does not start fan-out children while assembling the runtime", () =>
    Effect.gen(function* () {
      const model = yield* TestModel.make([])
      const fixture = yield* makeClient({
        replayEvents: [
          relayEvent("model.output.completed", 1, [Content.text("fallback")]),
          relayEvent("execution.completed", 2, [Content.text("done")]),
        ],
        streamEvents: [
          relayEvent("model.output.completed", 1, [Content.text("fallback")]),
          relayEvent("execution.completed", 2, [Content.text("done")]),
        ],
      })
      Object.assign(fixture.implementation.executions, { get: () => Effect.succeed({ status: "completed" }) })
      Object.assign(fixture.implementation.childRuns, {
        spawn: () => Effect.succeed({}),
        createFanOut: (definition: unknown) => Effect.succeed(definition),
        inspectFanOut: () => Effect.succeed({ fan_out: null }),
      })
      native.client = fixture.implementation
      yield* RelayExecutionBackend.layer({
        filename: ":memory:",
        workspace: "/tmp",
        registration: model.registration,
        selection: model.selection,
      }).pipe(Layer.provide(BunServices.layer), Layer.build)
      const registrations = yield* Ref.get(fixture.registrations)
      const starts = yield* Ref.get(fixture.starts)
      expect(registrations).toEqual([])
      expect(starts).toEqual([])
    }),
  )
})

describe("defaultModelResilience", () => {
  const retryableFailure = AiError.make({
    module: "OpenAiClient",
    method: "createResponseStream",
    reason: AiError.InvalidOutputError.make({ description: "boom" }),
  })

  it("classifies retryable model errors as transient and everything else as terminal", () => {
    expect(RelayExecutionBackend.defaultModelResilience.classify(retryableFailure)).toBe("transient")
    expect(RelayExecutionBackend.defaultModelResilience.classify(new Error("boom"))).toBe("terminal")
  })

  it.effect("retries a pre-emission retryable stream failure with backoff", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = {
        streamText: () =>
          Stream.unwrap(
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.map((attempt) => (attempt === 1 ? Stream.fail(retryableFailure) : Stream.make("part"))),
            ),
          ),
      }
      const resilient = ModelResilience.apply(
        model as never,
        RelayExecutionBackend.defaultModelResilience,
      ) as unknown as typeof model
      const fiber = yield* Stream.runCollect(resilient.streamText()).pipe(Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(fiber)).toEqual(["part"])
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )

  it.effect("does not retry terminal stream failures", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failure = new Error("terminal")
      const model = {
        streamText: () =>
          Stream.unwrap(Ref.updateAndGet(attempts, (count) => count + 1).pipe(Effect.map(() => Stream.fail(failure)))),
      }
      const resilient = ModelResilience.apply(
        model as never,
        RelayExecutionBackend.defaultModelResilience,
      ) as unknown as typeof model
      const fiber = yield* Stream.runCollect(resilient.streamText()).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(fiber)).toBe(failure)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
