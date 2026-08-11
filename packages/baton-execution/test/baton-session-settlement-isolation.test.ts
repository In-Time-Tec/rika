import { Agent, AgentManifest, Pins, Prompt } from "@batonfx/core"
import {
  Address,
  ExecutableManifest,
  ExecutableRegistration,
  ExecutableResolver,
  RunStore,
  Runtime,
} from "@batonfx/runtime"
import { TestModel } from "@batonfx/test"
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Random } from "effect"

const modelPin = Pins.makeModel({ provider: "test", model: "settlement-isolation" })
const policy = { _tag: "Portable" as const, policy: { _tag: "Forever" as const } }

const fixture = Effect.gen(function* () {
  const model = yield* TestModel.make([], { provider: "test", model: "settlement-isolation" })
  const childAgent = Agent.make({ name: "researcher" })
  const child = AgentManifest.fromLiveAgent(childAgent, {
    model: modelPin,
    tools: [],
    skills: [],
    services: [],
    policy,
    budget: {},
    children: [],
  })
  const parentAgent = Agent.make({ name: "assistant" })
  const parent = AgentManifest.fromLiveAgent(parentAgent, {
    model: modelPin,
    tools: [],
    skills: [],
    services: [],
    policy,
    budget: {},
    children: [{ selection: "researcher", agent: child.pin }],
  })
  const entries = [
    { _tag: "Agent" as const, ...parent },
    { _tag: "Agent" as const, ...child },
  ]
  const parentExecutable = ExecutableManifest.make({ root: parent.pin, entries })
  const childExecutable = ExecutableManifest.make({ root: parent.pin, active: child.pin, entries })
  const parentClosed = Agent.close(parentAgent, model.layer)
  const childClosed = Agent.close(childAgent, model.layer)
  const resolver = ExecutableResolver.makeStatic([
    { executable: parentExecutable, agent: parentClosed },
    { executable: childExecutable, agent: childClosed },
  ])
  const registrations = [...ExecutableRegistration.requiredPins(parentExecutable)].map((pin) => ({
    pin,
    codec: "test",
    version: "1",
    payload: {},
  }))
  const unique = yield* Random.nextIntBetween(1, 2 ** 31)
  return { parentExecutable, resolver, registrations, unique }
})

const runtimeLayer = Layer.unwrap(
  fixture.pipe(
    Effect.map(({ parentExecutable, resolver, registrations, unique }) =>
      Runtime.layerSqlite({
        filename: `/tmp/rika-baton-settlement-isolation-${process.pid}-${unique}.db`,
        resolver,
        addresses: [
          {
            address: Address.make("agent:assistant"),
            executable: parentExecutable,
            registrations,
          },
        ],
        scheduler: { pollInterval: "1 hour" },
      }),
    ),
  ),
)

layer(runtimeLayer)("Baton Session child settlement isolation", (it) => {
  it.effect("never exposes an earlier root's child settlement as a later root's generic message", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime
      const store = yield* RunStore.RunStore
      const sessionId = "shared-session"
      const first = yield* runtime.send({
        to: Address.make("agent:assistant"),
        sessionId,
        idempotencyKey: "root-1",
        prompt: "first",
      })
      const child = yield* runtime.spawn({
        parentRunId: first.runId,
        invocationId: "child",
        selection: "researcher",
        prompt: "child",
      })
      const second = yield* runtime.send({
        to: Address.make("agent:assistant"),
        sessionId,
        idempotencyKey: "root-2",
        prompt: "second",
      })
      const claim = yield* store.claimExecution({ runId: child.runId, ownerId: "test" })
      yield* store.complete({
        ...claim,
        result: { text: "notes", turns: 1, transcript: Prompt.fromMessages([]) },
      })

      expect(yield* runtime.childSettlements({ parentRunId: first.runId, limit: 10 })).toMatchObject([
        { parentRunId: first.runId, childRunId: child.runId, resultText: "notes" },
      ])
      expect(yield* runtime.childSettlements({ parentRunId: second.runId, limit: 10 })).toEqual([])
      expect(yield* runtime.messages({ runId: second.runId, limit: 10 })).toEqual([])
    }),
  )
})
