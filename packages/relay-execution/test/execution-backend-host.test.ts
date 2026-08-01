import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"

import { ModelResilience } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Content } from "@relayfx/sdk"
import { Effect, Layer, Redacted, Ref, Schedule, Schema } from "effect"

import { Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"

import { fixture as testSupport } from "./execution-backend-fixture"
const { native, relayEvent, makeClient, provideBackend, RelayExecutionBackend } = testSupport
it("always offers the web tools so the emitted tool list keeps one shape", () => {
  const tools = Object.keys(RelayExecutionBackend.toolkitFor({}).tools)

  expect(tools).toContain("web_search")
  expect(tools).toContain("read_web_page")
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
const buildRuntimeLayer = Effect.fn("ExecutionBackendTest.buildRuntimeLayer")(function* (filename: string) {
  const model = yield* TestModel.make([])
  const fixture = yield* makeClient({})
  Object.assign(fixture.implementation.executions, { get: () => Effect.succeed({ status: "completed" }) })
  Object.assign(fixture.implementation.childRuns, {
    spawn: () => Effect.succeed({}),
    createFanOut: (definition: unknown) => Effect.succeed(definition),
    inspectFanOut: () => Effect.succeed({ fan_out: null }),
  })
  native.client = fixture.implementation
  native.databaseOptions = []
  yield* RelayExecutionBackend.layer({
    filename,
    workspace: "/tmp",
    registration: model.registration,
    selection: model.selection,
  }).pipe(Layer.provide(BunServices.layer), Layer.build)
  return native.databaseOptions
})
it.effect("archives a persistent Relay database into the data root that holds it", () =>
  Effect.gen(function* () {
    const calls = yield* buildRuntimeLayer("/tmp/rika-profile/execution.db")
    expect(calls).toEqual([
      {
        filename: "/tmp/rika-profile/execution.db",
        eventHistory: { _tag: "FileSystem", directory: "/tmp/rika-profile/execution-event-history" },
      },
    ])
  }),
)
it.effect("derives the same history directory on every start for one data root", () =>
  Effect.gen(function* () {
    const first = yield* buildRuntimeLayer("/tmp/rika-profile/execution.db")
    const second = yield* buildRuntimeLayer("/tmp/rika-profile/execution.db")
    expect(second).toEqual(first)
  }),
)
it.effect("never sends event history to an in-memory Relay database", () =>
  Effect.gen(function* () {
    const calls = yield* buildRuntimeLayer(":memory:")
    expect(calls).toEqual([{ filename: ":memory:" }])
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
