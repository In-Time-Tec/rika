import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { vi } from "vitest"
import { ModelResilience } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Client, Content, Execution, Ids } from "@relayfx/sdk"
import { ThreadTools } from "@rika/tools"
import { Effect, Layer, Redacted, Ref, Schedule, Stream } from "effect"
import { Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

const native = vi.hoisted(() => ({ client: undefined as Client.Interface | undefined, results: [] as Array<unknown> }))

vi.mock("@relayfx/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@relayfx/sdk")>()
  const { Layer: EffectLayer } = await import("effect")
  return {
    ...actual,
    Client: {
      ...actual.Client,
      layerFromRuntime: EffectLayer.suspend(() => actual.Client.testLayer(native.client!)),
    },
  }
})

vi.mock("@relayfx/sdk/sqlite", async () => {
  const { Context: EffectContext, Effect: NativeEffect, Layer: NativeLayer } = await import("effect")
  class FanOutRuntimeService extends EffectContext.Service<FanOutRuntimeService, any>()(
    "rika-test/ChildFanOutRuntime",
  ) {}
  class FanOutHandlerService extends EffectContext.Service<FanOutHandlerService, any>()(
    "rika-test/ChildFanOutHandlers",
  ) {}
  class WorkflowHandlerService extends EffectContext.Service<WorkflowHandlerService, any>()(
    "rika-test/WorkflowHandlers",
  ) {}
  const ChildFanOutRuntimeMock = { Service: FanOutRuntimeService, HandlerService: FanOutHandlerService }
  const WorkflowDefinitionRuntimeMock = { HandlerService: WorkflowHandlerService }
  const fanOutService = FanOutRuntimeService.of({
    create: (definition: unknown) => (native.results.push(["create", definition]), NativeEffect.succeed(definition)),
    inspect: (id: unknown) => (native.results.push(["inspect", id]), NativeEffect.succeed(undefined)),
    cancel: (id: unknown) => (native.results.push(["cancelFan", id]), NativeEffect.succeed(undefined)),
  } as never)
  return {
    ChildFanOutRuntime: ChildFanOutRuntimeMock,
    WorkflowDefinitionRuntime: WorkflowDefinitionRuntimeMock,
    LanguageModelService: { layer: () => NativeLayer.empty, layerFromRegistrationEffects: () => NativeLayer.empty },
    RunnerRuntime: { layerWithServices: () => NativeLayer.empty },
    SchemaRegistry: { layer: () => NativeLayer.empty },
    ToolRuntime: { layerFromToolkit: () => NativeLayer.empty },
    SQLite: {
      layer: () => NativeLayer.empty,
      childFanOutLayer: (_options: unknown, handlers: Layer.Layer<unknown>) =>
        Layer.succeed(FanOutRuntimeService, fanOutService).pipe(
          Layer.tap(() =>
            Layer.build(handlers).pipe(
              Effect.flatMap((context) => {
                const handler = EffectContext.get(context, FanOutHandlerService) as unknown as {
                  execute: (...args: Array<unknown>) => Effect.Effect<unknown>
                  cancel: (...args: Array<unknown>) => Effect.Effect<unknown>
                }
                const child = {
                  child_execution_id: "child:native",
                  address_id: "address:rika",
                  input: [{ type: "text" as const, text: "work" }],
                  metadata: { source: "test" },
                }
                return Effect.all([
                  handler.execute(child as never, { fan_out_id: "fan:native" } as never, "key"),
                  handler.cancel("child:native" as never),
                ]).pipe(Effect.tap((values) => Effect.sync(() => native.results.push(...values))))
              }),
              Effect.scoped,
            ),
          ),
        ),
      workflowLayer: (_options: unknown, handlers: Layer.Layer<unknown>) =>
        Layer.effectDiscard(
          Layer.build(handlers).pipe(
            Effect.flatMap((context) => {
              const handler = EffectContext.get(context, WorkflowHandlerService) as unknown as {
                child: (...args: Array<unknown>) => Effect.Effect<unknown>
                approval: (...args: Array<unknown>) => Effect.Effect<unknown>
                timer: (...args: Array<unknown>) => Effect.Effect<unknown>
                branch: (...args: Array<unknown>) => Effect.Effect<unknown>
                structuredCompletion: (...args: Array<unknown>) => Effect.Effect<unknown>
                createChildFanOut: (...args: Array<unknown>) => Effect.Effect<unknown>
                admitChildFanOut: (...args: Array<unknown>) => Effect.Effect<unknown>
                inspectChildFanOut: (...args: Array<unknown>) => Effect.Effect<unknown>
              }
              return Effect.all([
                handler.child(
                  "execution:parent" as never,
                  { id: "grounded", address_id: "address:other", preset_name: "Task", input: { a: 1 } } as never,
                ),
                handler.child("execution:parent" as never, { id: "default", input: undefined } as never),
                handler.approval("execution:parent" as never, { prompt: "approve" } as never),
                handler.timer("execution:parent" as never, { duration_ms: 0 } as never),
                handler.branch(),
                handler.structuredCompletion({} as never, undefined),
                handler.structuredCompletion({} as never, { ok: true }),
                handler.createChildFanOut({ fan_out_id: "fan:workflow" } as never),
                handler.admitChildFanOut({} as never),
                handler.inspectChildFanOut("fan:workflow" as never),
              ]).pipe(Effect.tap((values) => Effect.sync(() => native.results.push(...values))))
            }),
            Effect.scoped,
          ),
        ),
    },
  }
})

const selection = { provider: "test", model: "model" }
const unused = () => Effect.die("unused client method")
const clientFailure = (message: string) => new Client.ClientError({ message })
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
  readonly openWaitIds?: ReadonlyArray<string>
  readonly cancelStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly fail?: "register" | "start" | "lookup" | "replay" | "cancel"
}) {
  const registrations = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["registerAgent"]>[0]>>([])
  const starts = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["startExecutionByAgentDefinition"]>[0]>>([])
  const lookups = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["getExecution"]>[0]>>([])
  const replays = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["replayExecution"]>[0]>>([])
  const cancellations = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["cancelExecution"]>[0]>>([])
  const nextRevision = yield* Ref.make(40)
  const implementation: Client.Interface = {
    registerAgent: (input) =>
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
    startExecutionByAgentDefinition: (input) =>
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
    cancelExecution: (input) =>
      Ref.update(cancellations, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "cancel"
            ? Effect.fail(clientFailure("cancel failed"))
            : Effect.succeed({ execution_id: input.execution_id, status: options?.cancelStatus ?? "running" }),
        ),
      ),
    steer: unused,
    getExecution: (input) =>
      Ref.update(lookups, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "lookup"
            ? Effect.fail(clientFailure("lookup failed"))
            : Effect.succeed(
                options?.existingStatus === undefined
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
    replayExecution: (input) =>
      Ref.update(replays, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "replay"
            ? Effect.fail(clientFailure("replay failed"))
            : Effect.succeed({ events: options?.replayEvents ?? [] }),
        ),
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
    followExecution: () => Stream.empty,
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
  return { implementation, registrations, starts, lookups, replays, cancellations }
})

const provideBackend = (implementation: Client.Interface, includeThreadTools = false) =>
  Effect.provide(
    RelayExecutionBackend.layerFromClient({
      selection,
      ...(includeThreadTools ? { additionalToolkit: ThreadTools.toolkit } : {}),
    }).pipe(Layer.provide(Client.testLayer(implementation))),
  )

const provideConfiguredBackend = (
  implementation: Client.Interface,
  options: Parameters<typeof RelayExecutionBackend.layerFromClient>[0],
) =>
  Effect.provide(RelayExecutionBackend.layerFromClient(options).pipe(Layer.provide(Client.testLayer(implementation))))

describe("ExecutionBackend Relay client adapter", () => {
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
        return yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 100 })
      }).pipe(provideBackend(fixture.implementation, true))
      const registrations = yield* Ref.get(fixture.registrations)
      const starts = yield* Ref.get(fixture.starts)
      expect(yield* Ref.get(fixture.lookups)).toEqual([])
      expect(registrations[0]?.id).toBe("agent:rika")
      expect(registrations[0]?.address).toBe("address:rika")
      expect((starts[0] as { agent_revision?: number }).agent_revision).toBe(40)
      const registration = registrations[0]
      if (registration === undefined || !("agent" in registration)) return yield* Effect.die("Missing Baton agent")
      expect(Object.keys(registration.agent.toolkit.tools)).toEqual([
        "find_files",
        "grep",
        "read_file",
        "create_file",
        "edit_file",
        "apply_patch",
        "shell",
        "shell_command_status",
        "git_status",
        "web_search",
        "read_web_page",
        "view_media",
        "find_thread",
        "read_thread",
      ])
      expect(registration.metadata?.multi_agent_enabled).toBe(true)
      expect(registration.permissions).toContainEqual({ name: "relay.child_run.spawn", value: true })
      expect(registration.handoff_targets).toEqual([
        { name: "oracle", preset_name: "Oracle" },
        { name: "librarian", preset_name: "Librarian" },
        { name: "review", preset_name: "Review" },
        { name: "read_thread", preset_name: "ReadThread" },
        { name: "task", preset_name: "Task" },
      ])
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

  it.effect("sends ordered image content to Relay and Baton", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.start({
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
          return yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
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
        return yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
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
        return yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
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
          return yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.status).toBe("completed")
      }),
  )

  it.effect.each(["queued", "running"] as const)(
    "returns waiting when a %s execution reaches either actionable request",
    (startStatus) =>
      Effect.gen(function* () {
        yield* Effect.forEach(["permission.ask.requested", "tool.approval.requested"] as const, (actionableType) =>
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
              return yield* backend.start({
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
        )
      }),
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
          return yield* backend.start({
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

  it.effect("selects the effort and fast variant registration per start", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.start({
          threadId: "thread-variant",
          turnId: "turn-variant",
          prompt: "prompt",
          startedAt: 1,
          reasoningEffort: "xhigh",
          fastMode: true,
        })
      }).pipe(provideBackend(fixture.implementation))
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
        | { agent?: { model?: { registrationKey?: string } } }
        | undefined
      expect(registered?.agent?.model?.registrationKey).toBe("effort:xhigh:fast")
      expect(RelayExecutionBackend.modelVariantKey("high", false)).toBe("effort:high")
    }),
  )

  it.effect("retains a fixed model selection when variants are unsupported", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.start({
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
        | { agent?: { model?: { registrationKey?: string } } }
        | undefined
      expect(registered?.agent?.model).toEqual(selection)
      expect(registered?.agent?.model?.registrationKey).toBeUndefined()
    }),
  )

  it.effect("registers compaction, budget, and permission policy options", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const permissionPolicy = [{ tool: "shell", action: "deny" }] as never
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
          tokenBudget: 8_000,
          permissionPolicy,
        }),
      )
      expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({
        permission_rules: permissionPolicy,
        token_budget: 8_000,
        metadata: { steering_enabled: true },
        compaction_policy: {
          context_window: 10_000,
          reserve_tokens: 500,
          keep_recent_tokens: 2_000,
        },
      })
    }),
  )

  it.effect("omits incomplete compaction policies", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(provideConfiguredBackend(fixture.implementation, { selection, compaction: {} }))

      expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({ metadata: { steering_enabled: true } })
      expect((yield* Ref.get(fixture.registrations))[0]).not.toHaveProperty("compaction_policy")
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

  it.effect("derives terminal replay status when a late model event follows it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        replayEvents: [relayEvent("execution.cancelled", 1), relayEvent("model.output.completed", 2)],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.replay("turn-a")
      }).pipe(provideBackend(fixture.implementation))
      expect(result.status).toBe("cancelled")
    }),
  )

  it.effect("cancels with deterministic payload and returns the accepted status and replayed events", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
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

  it.effect.each(["start", "replay", "cancel"] as const)("maps %s client failures to BackendError", (operation) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ fail: operation })
      const failure = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (operation === "start")
          return yield* Effect.flip(
            backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "p", startedAt: 1 }),
          )
        if (operation === "replay") return yield* Effect.flip(backend.replay("turn-a"))
        return yield* Effect.flip(backend.cancel("turn-a", 2))
      }).pipe(provideBackend(fixture.implementation))
      expect(failure._tag).toBe("ExecutionBackendError")
      expect(failure.message).toContain(`${operation} failed`)
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
        return yield* backend.start({
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
        return yield* backend.start({
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
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a"])
      expect(yield* Ref.get(fixture.replays)).toEqual([{ execution_id: "execution:turn-a" }])
    }),
  )

  it.effect("preserves the start failure when reconciliation lookup fails", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ fail: "lookup" })
      const implementation: Client.Interface = {
        ...fixture.implementation,
        startExecutionByAgentDefinition: () => Effect.fail(clientFailure("start failed")),
      }
      const failure = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* Effect.flip(
          backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 }),
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
          backend.start({ threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 }),
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
      Object.assign(fixture.implementation, {
        createChildFanOut: (input: unknown) => (calls.push(["createFanOut", input]), Effect.succeed(fanOut)),
        inspectChildFanOut: (input: unknown) => (
          calls.push(["inspectFanOut", input]),
          Effect.succeed({ fan_out: fanOut })
        ),
        cancelChildFanOut: (input: unknown) => (
          calls.push(["cancelFanOut", input]),
          Effect.succeed({ fan_out: fanOut })
        ),
        registerWorkflowDefinition: (input: { definition: { name: string } }) =>
          Effect.succeed({
            record: { definition: input.definition, revision: 1, digest: `digest-${input.definition.name}` },
          }),
        startWorkflowRun: (input: unknown) => (calls.push(["startWorkflow", input]), Effect.succeed(workflow)),
        inspectWorkflowRun: (input: unknown) => (calls.push(["inspectWorkflow", input]), Effect.succeed(workflow)),
        cancelWorkflowRun: (input: unknown) => (calls.push(["cancelWorkflow", input]), Effect.succeed(workflow)),
        spawnChildRun: (input: unknown) => (calls.push(["child", input]), Effect.succeed({})),
        getExecution: () => Effect.succeed({ status: "waiting" }),
        inspectExecution: () =>
          Effect.succeed({
            status: "waiting",
            last_event_cursor: "last",
            waiting_on: [{ wait_id: "wait-1", mode: "external", created_at: 1 }],
            pending_tool_calls: [
              { tool_call_id: "call-1", tool_name: "shell", input: { command: "pwd" }, requested_at: 2 },
            ],
            child_runs: [{ child_execution_id: "child:one", status: "completed" }],
          }),
        steer: (input: unknown) => (calls.push(["steer", input]), Effect.succeed({})),
        listPendingApprovals: () =>
          Effect.succeed({
            approvals: [{ wait_id: "wait-1", tool_call_id: "call-1", tool_name: "shell", input: {}, requested_at: 3 }],
          }),
        resolveToolApproval: (input: unknown) => (calls.push(["approval", input]), Effect.succeed({})),
        resolvePermission: (input: unknown) => (calls.push(["permission", input]), Effect.succeed({})),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return {
          fan: yield* backend.createFanOut({
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
      Object.assign(fixture.implementation, {
        inspectChildFanOut: () => Effect.succeed({ fan_out: undefined }),
        cancelChildFanOut: (input: unknown) => {
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
        inspectWorkflowRun: () => Effect.succeed(undefined),
        cancelWorkflowRun: () => Effect.succeed(undefined),
        startWorkflowRun: (input: unknown) => {
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
        getExecution: () => Effect.succeed(undefined),
        resolveToolApproval: (input: unknown) => (calls.push(input), Effect.succeed({})),
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
      Object.assign(fixture.implementation, {
        createChildFanOut: (input: unknown) => {
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
        getExecution: () => Effect.succeed({ status: "running" }),
        inspectExecution: () =>
          Effect.succeed({ status: "running", waiting_on: [], pending_tool_calls: [], child_runs: [] }),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        for (const join of ["all", "first-success", "best-effort"] as const) {
          yield* backend.createFanOut({
            fanOutId: `fan-${join}`,
            parentTurnId: "p",
            children: [],
            maxConcurrency: 1,
            join,
            createdAt: 1,
          })
        }
        yield* backend.createFanOut({
          fanOutId: "fan-quorum-default",
          parentTurnId: "p",
          children: [],
          maxConcurrency: 1,
          join: "quorum",
          createdAt: 1,
        })
        return {
          replay: yield* backend.replay("child:already-prefixed"),
          inspection: yield* backend.inspect("p"),
        }
      }).pipe(provideBackend(fixture.implementation))
      expect(inputs).toHaveLength(4)
      expect(result.replay.events[0]).not.toHaveProperty("text")
      expect(result.inspection).not.toHaveProperty("lastCursor")
    }),
  )

  it.effect("pins main and Oracle selections and alias-owned compaction policies", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const fanOutInputs: Array<any> = []
      Object.assign(fixture.implementation, {
        createChildFanOut: (input: any) => {
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
      const oracleSelection = { provider: "oracle-gateway", model: "oracle-model", registrationKey: "sol:high:normal" }
      const mainCompaction = { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 }
      const oracleCompaction = { contextWindow: 1_000_000, reserveTokens: 128_000, keepRecentTokens: 64_000 }
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.start({ threadId: "thread", turnId: "turn", prompt: "prompt", startedAt: 1 })
        yield* backend.createFanOut({
          fanOutId: "fan",
          parentTurnId: "turn",
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
        }),
      )
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as any
      expect(registered.agent.model).toEqual(selection)
      expect(registered.compaction_policy).toEqual({
        context_window: 372_000,
        reserve_tokens: 128_000,
        keep_recent_tokens: 32_000,
      })
      expect(registered.child_run_presets.Oracle.model).toEqual(oracleSelection)
      expect(registered.child_run_presets.Oracle.compaction_policy).toEqual({
        context_window: 1_000_000,
        reserve_tokens: 128_000,
        keep_recent_tokens: 64_000,
      })
      expect(registered.child_run_presets.Task.model).toEqual(selection)
      expect(fanOutInputs[0].children[0].override.model).toEqual(oracleSelection)
      expect(fanOutInputs[0].children[0].override.compaction_policy).toEqual(
        registered.child_run_presets.Oracle.compaction_policy,
      )
      expect(fanOutInputs[0].children[1].override.model).toEqual(selection)
      expect(fanOutInputs[0].children[1].override.compaction_policy).toEqual(registered.compaction_policy)
    }),
  )

  it("builds remote tool options with and without credentials", () => {
    const key = Redacted.make("secret")
    expect(RelayExecutionBackend.remoteToolOptions(undefined)).toEqual({})
    expect(RelayExecutionBackend.remoteToolOptions(key)).toEqual({ apiKey: key })
  })

  it.effect("ensures the thread host entity and notifies it through the durable inbox", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const kinds: Array<unknown> = []
      const sent: Array<Record<string, unknown>> = []
      Object.assign(fixture.implementation, {
        registerEntityKind: (input: unknown) =>
          Effect.sync(() => {
            kinds.push(input)
            return input
          }),
        getOrCreateEntity: (input: { readonly key: string }) =>
          Effect.succeed({
            kind: "rika-thread",
            key: input.key,
            address_id: `address:entity:${input.key}`,
            execution_id: `execution:entity:${input.key}`,
            generation: 0,
            status: "active",
            created_at: 1,
          }),
        getEntity: (input: { readonly key: string }) =>
          Effect.succeed({
            kind: "rika-thread",
            key: input.key,
            address_id: `address:entity:${input.key}`,
            execution_id: `execution:entity:${input.key}`,
            generation: 0,
            status: "active",
            created_at: 1,
          }),
        inspectExecution: (executionId: string) =>
          Effect.succeed({
            execution_id: executionId,
            status: "waiting",
            waiting_on: [{ wait_id: "wait:inbox:host", mode: "event", created_at: 1 }],
            pending_tool_calls: [],
            child_runs: [],
          }),
        send: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            sent.push(input)
            return { envelope_id: "envelope:notify", execution_id: `execution:entity:thread-a` }
          }),
      })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.ensureThreadHost!("thread-a", 100)
        yield* backend.ensureThreadHost!("thread-a", 101)
        yield* backend.notifyThreadHost!("thread-a", "turn-9", 102)
        yield* backend.notifyThreadHost!("thread-a", undefined, 103)
        yield* backend.registerTurnPromoter!(() => Effect.succeed(1))
      }).pipe(provideBackend(fixture.implementation))
      const registrations = yield* Ref.get(fixture.registrations)
      expect(registrations[0]?.id).toBe("agent:rika-thread-host")
      const registration = registrations[0]
      if (registration === undefined || !("agent" in registration)) return yield* Effect.die("Missing host agent")
      expect(registration.max_wait_turns).toBe(1_000_000)
      expect(registration.metadata?.steering_enabled).toBe(false)
      expect(Object.keys(registration.agent.toolkit.tools)).toEqual(["promote_turn"])
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
        idempotency_key: "rika:turn:turn-9",
      })
      expect(JSON.parse((sent[0]!.content as Array<{ text: string }>)[0]!.text)).toEqual({
        kind: "pending-turn",
        thread_id: "thread-a",
        turn_id: "turn-9",
      })
      expect(sent[1]).toMatchObject({ idempotency_key: "rika:nudge:thread-a:103" })
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
  ] as const)("builds the runtime layer with resilience=%s and extension handlers=%s", ([resilience, extensions]) =>
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
      Object.assign(fixture.implementation, {
        getExecution: () => Effect.succeed({ status: "completed" }),
        spawnChildRun: () => Effect.succeed({}),
      })
      native.client = fixture.implementation
      native.results.length = 0
      const result = yield* Layer.build(
        RelayExecutionBackend.layer({
          filename: ":memory:",
          workspace: "/tmp",
          registration: model.registration,
          selection: model.selection,
          ...(resilience ? { modelResilience: ModelResilience.make({ retrySchedule: Schedule.recurs(0) }) } : {}),
          ...(extensions ? { additionalToolkit: Toolkit.make(), additionalHandlerLayer: Layer.empty } : {}),
        }),
      ).pipe(Effect.provide(BunServices.layer), Effect.scoped, Effect.exit)
      expect(result._tag).toBe("Success")
      expect(native.results).toContainEqual({ status: "completed", output: [Content.text("done")] })
      expect(native.results).toContainEqual({ approved: true, prompt: "approve" })
      expect(native.results).toContainEqual(null)
      expect(native.results).toContainEqual({ ok: true })
    }),
  )

  it.effect("forwards every fan-out registration revision without model-facing subagent tools", () =>
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
      Object.assign(fixture.implementation, {
        getExecution: () => Effect.succeed({ status: "completed" }),
        spawnChildRun: () => Effect.succeed({}),
      })
      native.client = fixture.implementation
      native.results.length = 0
      yield* Layer.build(
        RelayExecutionBackend.layer({
          filename: ":memory:",
          workspace: "/tmp",
          registration: model.registration,
          selection: model.selection,
        }),
      ).pipe(Effect.provide(BunServices.layer), Effect.scoped)
      const registrations = yield* Ref.get(fixture.registrations)
      const starts = yield* Ref.get(fixture.starts)
      expect(registrations.length).toBeGreaterThan(0)
      expect(starts).toHaveLength(registrations.length)
      expect(starts.map((start) => (start as { agent_revision?: number }).agent_revision)).toEqual(
        registrations.map((_, index) => 40 + index),
      )
      for (const start of starts) {
        expect(start.session_id).toBe(`session:child:${String(start.execution_id)}`)
      }
      for (const registration of registrations) {
        const typed = registration as { metadata?: Record<string, unknown>; handoff_targets?: unknown }
        expect(typed.metadata?.multi_agent_enabled).not.toBe(true)
        expect(typed.handoff_targets).toBeUndefined()
      }
    }),
  )
})
