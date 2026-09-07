import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createClient } from "../../src/client/runtime"

it.effect("starts in the reference mode and archives only the selected offline thread", () =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "welcome" })),
      (value) => value.dispose,
    )
    expect(client.state.mode).toBe("medium")
    const original = client.state.selectedThreadId
    client.newThread()
    const archived = client.state.selectedThreadId
    client.archiveThread()
    expect(client.state.threads.some((thread) => thread.id === archived)).toBe(false)
    expect(client.state.threads.some((thread) => thread.id === original)).toBe(true)
    expect(client.state.selectedThreadId).toBe(original)
  }),
)
