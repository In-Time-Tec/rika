import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createClient } from "../../src/client/runtime"

it.effect("steering a pending instruction does not cancel the active reply", () =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "streaming", delayMs: 10_000 })),
      (value) => value.dispose,
    )
    client.submit("Focus on the public boundary")
    const thread = client.state.threads[0]!
    const reply = thread.items.find((item) => item.kind === "assistant")!
    const pending = thread.pending[0]!
    client.steerPending(pending.id)
    expect(thread.pending).toEqual([])
    expect(thread.activity).toBe("working")
    expect(reply.status).toBe("working")
    expect(thread.items.some((item) => item.text.includes("Focus on the public boundary"))).toBe(true)
  }),
)

it.effect("scenario replacement and disposal prevent delayed playback from modifying the new Thread", () =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "streaming", delayMs: 1 })),
      (value) => value.dispose,
    )
    client.loadScenario("welcome")
    yield* client.dispose
    expect(client.state.scenario).toBe("welcome")
    expect(client.state.threads[0]?.items).toEqual([])
    client.submit("must not be accepted after disposal")
    expect(client.state.threads[0]?.items).toEqual([])
  }),
)
