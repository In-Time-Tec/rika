import { describe, expect, test } from "bun:test"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { Connection } from "@rika/product/server-service"
import { Effect } from "effect"
import { makeRikaAdapter } from "./adapter"

const thread = {
  id: "thread-1",
  workspace: "/workspace",
  title: "A thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 2,
}

const fakeConnection = () => {
  let feedStarts = 0
  let eventConsumers = 0
  let interactiveInput: unknown
  let dispatch: ((event: InteractiveEvent.InteractiveEvent) => void) | undefined
  const commands: Array<{ readonly name: string; readonly values: ReadonlyArray<unknown> }> = []
  const session: InteractiveSession = {
    events: (next) =>
      Effect.sync(() => {
        eventConsumers++
        dispatch = next
      }).pipe(Effect.andThen(Effect.never)),
    submit: (...values) => Effect.sync(() => commands.push({ name: "submit", values })),
    shell: (...values) => Effect.sync(() => commands.push({ name: "shell", values })),
    editQueued: (...values) => Effect.sync(() => commands.push({ name: "editQueued", values })),
    dequeue: (...values) => Effect.sync(() => commands.push({ name: "dequeue", values })),
    steerQueued: (...values) => Effect.sync(() => commands.push({ name: "steerQueued", values })),
    steer: (...values) => Effect.sync(() => commands.push({ name: "steer", values })),
    approveAuthorization: (...values) => Effect.sync(() => commands.push({ name: "approve", values })),
    denyAuthorization: (...values) => Effect.sync(() => commands.push({ name: "deny", values })),
    interruptAndSend: (...values) => Effect.sync(() => commands.push({ name: "interruptAndSend", values })),
    cancel: Effect.sync(() => commands.push({ name: "cancel", values: [] })),
    quit: Effect.sync(() => commands.push({ name: "quit", values: [] })),
    newThread: Effect.sync(() => commands.push({ name: "newThread", values: [] })),
    selectThread: (...values) => Effect.sync(() => commands.push({ name: "selectThread", values })),
    readQueue: (...values) => Effect.sync(() => commands.push({ name: "readQueue", values })),
    previewThread: (...values) => Effect.sync(() => commands.push({ name: "previewThread", values })),
    reopenThread: Effect.sync(() => commands.push({ name: "reopenThread", values: [] })),
  }
  const connection: Connection = {
    role: "attached",
    endpoint: "ws://127.0.0.1:20000/server",
    connectionId: "connection-1",
    ping: Effect.void,
    run: (input, options) => {
      if (input._tag === "Interactive") {
        feedStarts++
        interactiveInput = input
        if (!options?.interactive) return Effect.void
        return options.interactive(input, session)
      }
      if (input._tag === "Thread" && input.action === "list")
        return options?.stdout?.(JSON.stringify([thread])) ?? Effect.void
      if (input._tag === "Thread" && (input.action === "new" || input.action === "fork"))
        return options?.stdout?.(JSON.stringify(thread)) ?? Effect.void
      return Effect.void
    },
    closed: Effect.never,
    close: Effect.void,
  }
  return {
    connection,
    commands,
    dispatch: (event: InteractiveEvent.InteractiveEvent) => dispatch?.(event),
    eventConsumers: () => eventConsumers,
    feedStarts: () => feedStarts,
    interactiveInput: () => interactiveInput,
  }
}

describe("Rika adapter", () => {
  test("caches one feed and one event consumer per workspace, including an empty profile", async () => {
    const fake = fakeConnection()
    const adapter = await Effect.runPromise(makeRikaAdapter(fake.connection, () => undefined))
    const first = await Effect.runPromise(adapter.directory("/workspace"))
    const second = await Effect.runPromise(adapter.directory("/workspace"))
    await Effect.runPromise(first.ready)

    expect(second).toBe(first)
    expect(fake.feedStarts()).toBe(1)
    expect(fake.eventConsumers()).toBe(1)
    expect(fake.interactiveInput()).toMatchObject({
      _tag: "Interactive",
      clientWorkspace: "/workspace",
      last: false,
    })
    await Effect.runPromise(adapter.dispose)
  })

  test("lists only real Rika Threads and serializes selection with submission", async () => {
    const fake = fakeConnection()
    const emitted: Array<{ workspace: string; types: ReadonlyArray<string> }> = []
    const adapter = await Effect.runPromise(
      makeRikaAdapter(fake.connection, (workspace, events) =>
        emitted.push({ workspace, types: events.map((event) => event.type) }),
      ),
    )
    const runtime = await Effect.runPromise(adapter.directory("/workspace"))
    await Effect.runPromise(runtime.ready)

    const listed = await Effect.runPromise(runtime.listThreads())
    await Effect.runPromise(runtime.submit({ threadId: "thread-1", prompt: "hello" }))

    expect(listed.map((session) => session.id)).toEqual(["thread-1"])
    expect(runtime.getThread("thread-1")?.title).toBe("A thread")
    expect(emitted.flatMap((entry) => entry.types)).toContain("session.updated")
    expect(fake.commands.slice(-2)).toEqual([
      { name: "selectThread", values: ["thread-1"] },
      { name: "submit", values: ["hello", undefined, undefined, {}, undefined] },
    ])
    await Effect.runPromise(adapter.dispose)
  })
})
