/* oxlint-disable anti-slop/no-chained-type-assertions -- hosted adapter tests narrow minimal transport doubles. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures intentionally stand in for released transport values. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- fixture transport values are checked by the adapter assertions. */
/* oxlint-disable effecttsgo/global-timers-in-effect -- native timers let this test await ManagedRuntime fork completion under @effect/vitest. */
/* oxlint-disable effecttsgo/new-promise -- native timer bridge is the test's asynchronous observation boundary. */
/* oxlint-disable eslint(no-promise-executor-return) -- the timer callback intentionally returns the timeout handle. */
import { expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { ExecutableManifest } from "generalist"
import type { ExecutionClient, GeneralistSnapshot } from "@rika/client-v2/generalist"
import type { ProductClient } from "@rika/client-v2/product"
import { createHostedClient } from "../../src/client/hosted"

const snapshot = {
  version: 1,
  session: {
    id: "session",
    title: "Hosted TUI",
    createdAt: "2026-09-09T00:00:00.000Z",
    queue: [],
    activeRunId: "run",
  },
  cursor: 0,
  runs: [{ runId: "run", rootRunId: "run", status: "running", cursor: 0, turn: 1 }],
  conversation: { leafId: null, entries: [] },
} as unknown as GeneralistSnapshot

const executable = ExecutableManifest.makeTest("hosted-client")("agent")

const product = (): ProductClient => ({
  identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
  listThreads: () =>
    Effect.succeed({ threads: [{ id: "thread", title: "Hosted", target: "runner" }], nextCursor: null }),
  thread: () => Effect.succeed({ id: "thread", title: "Hosted", target: "runner" }),
  access: () => Effect.succeed({ threadId: "thread", role: "controller" }),
  catalog: Effect.succeed({ modes: [] }),
  ensureSession: () => Effect.succeed({ sessionId: "session", created: false }),
})

const waitForDetached = (millis: number) =>
  Effect.callback<void>((resume) => {
    // ast-grep-ignore: effect-prefer-scheduling -- this fixture waits for a detached ManagedRuntime fiber.
    const timer = setTimeout(() => resume(Effect.void), millis)
    return Effect.sync(() => clearTimeout(timer))
  })

it.effect("routes hosted follow-up, stop, and cancel controls to the canonical client", () => {
  const calls = { submit: [] as string[], control: [] as string[], cancel: [] as string[] }
  const connection = {
    snapshot,
    events: Stream.empty,
    status: Stream.empty,
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(snapshot),
    history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
    family: () =>
      Effect.succeed({
        rootSessionId: "session",
        at: 0,
        sessions: [
          {
            id: "retained-child",
            rootSessionId: "session",
            parentSessionId: "session",
            parentRunId: "run",
            initialRunId: "child-run",
            depth: 1,
          },
        ],
        nextBefore: null,
      }),
    submit: ({ sessionId }: { readonly sessionId: string }) =>
      Effect.sync(() => {
        calls.submit.push(sessionId)
        return { id: "receipt", revision: 1 }
      }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    steer: () => Effect.void,
    cancel: ({ runId }: { readonly runId: string }) =>
      Effect.sync(() => {
        calls.cancel.push(runId)
      }),
    control: ({ action }: { readonly action: string }) =>
      Effect.sync(() => {
        calls.control.push(action)
      }),
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = createHostedClient({
    product: product(),
    execution,
    initialThreadId: "thread",
    webSocketConstructor: () => ({}) as WebSocket,
  })
  return Effect.gen(function* () {
    yield* waitForDetached(50)
    client.openChildSession?.("retained-child")
    yield* waitForDetached(50)
    client.followUp("continue", "retained-child")
    client.stop()
    client.cancel()
    yield* waitForDetached(50)
    expect(calls.submit).toEqual(["retained-child"])
    expect(calls.control).toEqual(["stop"])
    expect(calls.cancel).toEqual(["run"])
    yield* client.dispose
  })
})

it.effect("keeps hosted connections connected and rejects unsupported images before enqueue", () => {
  const calls = { submit: 0, cancel: 0 }
  const connection = {
    snapshot,
    events: Stream.empty,
    status: Stream.succeed({ _tag: "Connected" as const, epoch: 0 }),
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(snapshot),
    history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () =>
      Effect.sync(() => {
        calls.submit += 1
        return { id: "receipt", revision: 1 }
      }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    steer: () => Effect.void,
    cancel: () =>
      Effect.sync(() => {
        calls.cancel += 1
      }),
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = createHostedClient({
    product: product(),
    execution,
    initialThreadId: "thread",
    webSocketConstructor: () => ({}) as WebSocket,
  })
  return Effect.gen(function* () {
    yield* waitForDetached(50)
    expect(client.state.connection).toBe("connected")
    client.submit("", [{ path: "clipboard.png", mediaType: "image/png" }])
    client.interruptAndSend("continue", [{ path: "clipboard.png", mediaType: "image/png" }])
    yield* waitForDetached(50)
    expect(calls).toEqual({ submit: 0, cancel: 0 })
    expect(client.state.notice).toContain("image attachments are not supported")
    yield* client.dispose
  })
})

it.effect("does not remove queued input when steering fails", () => {
  const calls = { remove: 0, steer: 0 }
  const queuedSnapshot = {
    ...snapshot,
    session: {
      ...snapshot.session,
      activeRunId: "run",
      queue: [
        {
          id: "pending",
          revision: 1,
          prompt: { content: [{ role: "user", content: "queued prompt" }] },
          selection: { executableRef: executable.ref, executableManifest: executable.manifest, registrations: [] },
        },
      ],
    },
  } as unknown as GeneralistSnapshot
  const connection = {
    snapshot: queuedSnapshot,
    events: Stream.empty,
    status: Stream.succeed({ _tag: "Connected" as const, epoch: 0 }),
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(queuedSnapshot),
    history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "receipt", revision: 1 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    removeInput: () =>
      Effect.sync(() => {
        calls.remove += 1
        return { id: "pending", revision: 2 }
      }),
    steer: () =>
      Effect.sync(() => {
        calls.steer += 1
      }).pipe(Effect.andThen(Effect.fail({ message: "steering rejected" }))),
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = createHostedClient({
    product: product(),
    execution,
    initialThreadId: "thread",
    webSocketConstructor: () => ({}) as WebSocket,
  })
  return Effect.gen(function* () {
    yield* waitForDetached(50)
    client.steerPending("pending")
    yield* waitForDetached(50)
    expect(calls).toEqual({ remove: 0, steer: 1 })
    expect(client.state.notice).toContain("steering rejected")
    expect(client.state.threads[0]?.pending[0]?.id).toBe("pending")
    yield* client.dispose
  })
})

it.effect("loads an older hosted history page through the public TUI client", () => {
  const pagingSnapshot = {
    ...snapshot,
    conversation: {
      leafId: "latest",
      entries: [{ id: "current", parentId: "anchor", messages: [{ role: "assistant", content: "Current" }] }],
      nextLeafId: "anchor",
    },
  } as unknown as GeneralistSnapshot
  let historyCalls = 0
  const connection = {
    snapshot: pagingSnapshot,
    events: Stream.empty,
    status: Stream.empty,
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(pagingSnapshot),
    history: () =>
      Effect.sync(() => {
        historyCalls += 1
        return {
          leafId: "anchor",
          entries: [{ id: "older", parentId: "root", messages: [{ role: "assistant", content: "Loaded older" }] }],
          nextLeafId: null,
        }
      }),
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "receipt", revision: 1 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    steer: () => Effect.void,
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = createHostedClient({
    product: product(),
    execution,
    initialThreadId: "thread",
    webSocketConstructor: () => ({}) as WebSocket,
  })
  return Effect.gen(function* () {
    yield* waitForDetached(50)
    client.loadOlder?.()
    yield* waitForDetached(50)
    expect(historyCalls).toBe(1)
    expect(client.state.threads[0]?.items.some((item) => item.text === "Loaded older")).toBe(true)
    yield* client.dispose
  })
})
