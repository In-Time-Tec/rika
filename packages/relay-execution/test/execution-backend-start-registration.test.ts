import { expect, it } from "@effect/vitest"

import { Content } from "@relayfx/sdk"
import { Effect, Ref } from "effect"

import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"

import { fixture as testSupport } from "./execution-backend-fixture"
const { relayEvent, makeClient, provideBackendWithThreadTools } = testSupport
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
      return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
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
    expect((registration as { readonly tool_execution?: unknown }).tool_execution).toEqual({
      concurrency: "unbounded",
    })
    expect(registration.instructions).toContain("Route delegation by purpose")
    expect(registration.instructions).toContain("do not use Oracle to search or explore the codebase")
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
      input: [Content.text("prompt")],
    })
    expect(result.status).toBe("completed")
    expect(result.events).toEqual([
      {
        executionId: "execution:turn-a",
        cursor: "cursor-1",
        sequence: 1,
        type: "model.output.delta",
        createdAt: 10,
        text: "hello world",
        content: [Content.text("hello "), { type: "structured", value: { n: 1 } }, Content.text("world")],
      },
      {
        executionId: "execution:turn-a",
        cursor: "cursor-2",
        sequence: 2,
        type: "model.output.delta",
        createdAt: 20,
        content: [],
      },
      {
        executionId: "execution:turn-a",
        cursor: "cursor-3",
        sequence: 3,
        type: "execution.completed",
        createdAt: 30,
      },
    ])
  }),
)
