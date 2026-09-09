/* oxlint-disable typescript/no-unsafe-type-assertion -- the fixture intentionally narrows a transport double to the public client surface. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- transport doubles are intentionally narrowed in these focused tests. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- transport doubles use one boundary assertion for the public client surface. */
/* oxlint-disable effecttsgo/global-timers-in-effect -- detached connection tests need a bounded scheduler turn. */
/* oxlint-disable effecttsgo/new-promise -- detached connection tests need a bounded scheduler turn. */
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { ExecutableManifest } from "generalist"
import { Server } from "generalist/server"
import type { ExecutionClient, GeneralistSnapshot } from "../src/generalist"
import { makeThreadClient, ThreadClientError } from "../src/thread"
import type { ProductClient } from "../src/product"

const executable = ExecutableManifest.makeTest("thread-test")("agent")

const snapshot = Schema.decodeSync(Server.SessionSnapshot)({
  version: 1,
  session: {
    id: "session",
    title: "Hosted thread",
    createdAt: "2026-09-09T00:00:00.000Z",
    queue: [
      {
        id: "pending",
        revision: 4,
        prompt: { content: [{ role: "user", content: "queued instruction" }] },
        selection: {
          executableRef: executable.ref,
          executableManifest: executable.manifest,
          registrations: [],
        },
      },
    ],
    activeRunId: "run",
  },
  cursor: 0,
  runs: [
    {
      runId: "run",
      rootRunId: "run",
      status: "running",
      cursor: 0,
      turn: 1,
    },
  ],
  conversation: { leafId: null, entries: [] },
})

const product = (): ProductClient => ({
  identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
  listThreads: () => Effect.succeed({ threads: [{ id: "thread", title: "Hosted", target: "runner" }], nextCursor: null }),
  thread: () => Effect.succeed({ id: "thread", title: "Hosted", target: "runner" }),
  access: () => Effect.succeed({ threadId: "thread", role: "controller" }),
  catalog: Effect.succeed({ modes: [] }),
  ensureSession: () => Effect.succeed({ sessionId: "session", created: false }),
})

const waitForDetached = (millis: number) =>
  Effect.callback<void>((resume) => {
    // ast-grep-ignore: effect-prefer-scheduling -- this fixture waits for an owned connection fiber to start.
    const timer = setTimeout(() => resume(Effect.void), millis)
    return Effect.sync(() => clearTimeout(timer))
  })

it.effect("steers the canonical active Run and never cancels it when the client closes", () => {
  const calls = { steer: [] as string[], cancel: 0 }
  const conflict = {
    _tag: "generalist/session/SessionQueueConflict",
    reason: "revision",
    hint: "Pending input was promoted before this edit committed",
  }
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
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "new", revision: 5 }),
    updateInput: () => Effect.fail(conflict),
    removeInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    steer: ({ runId }: { readonly runId: string }) =>
      Effect.sync(() => {
        calls.steer.push(runId)
        return undefined
      }),
    cancel: () =>
      Effect.sync(() => {
        calls.cancel += 1
      }),
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    const receipt = yield* client.steer("focus on the committed path")
    expect(receipt.status).toBe("accepted")
    expect(calls.steer).toEqual(["run"])
    const failure = yield* Effect.result(client.editQueued("pending", "late edit"))
    expect(failure._tag).toBe("Failure")
    if (failure._tag === "Failure") expect(failure.failure).toBeInstanceOf(ThreadClientError)
    yield* client.dispose
    expect(calls.cancel).toBe(0)
  })
})

it.effect("targets retained child follow-ups and scoped Session/run controls", () => {
  const calls = {
    submit: [] as string[],
    cancel: [] as string[],
    control: [] as string[],
  }
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
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: ({ sessionId }: { readonly sessionId: string }) =>
      Effect.sync(() => {
        calls.submit.push(sessionId)
        return { id: "follow-up", revision: 1 }
      }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 5 }),
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
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    yield* client.followUp("continue child", "retained-child-session")
    yield* client.cancel("cancel-command", "stop now")
    yield* client.stop("stop-command")
    expect(calls.submit).toEqual(["retained-child-session"])
    expect(calls.cancel).toEqual(["run"])
    expect(calls.control).toEqual(["stop"])
    yield* client.dispose
  })
})

it.effect("passes credential-service headers to every WebSocket reconnect", () => {
  const upgrades: Array<{ readonly url: string; readonly headers: Readonly<Record<string, string>> | undefined }> = []
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
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "new", revision: 5 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    steer: () => Effect.void,
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () =>
      Effect.gen(function* () {
        const constructor = yield* Socket.WebSocketConstructor
        constructor("wss://rika.test/sessions/session/ws", ["rika.v1"])
        constructor("wss://rika.test/sessions/session/ws?cursor=4", ["rika.v1"])
        return connection
      }),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = makeThreadClient({
    product: product(),
    execution,
    webSocketConstructor: (url, _protocols, headers) => {
      upgrades.push({ url, headers })
      return {} as WebSocket
    },
    webSocketHeaders: ({ url, method }) =>
      Effect.gen(function* () {
        yield* Effect.yieldNow
        return {
          authorization: "DPoP access",
          dpop: `proof-${method}-${url}`,
        }
      }),
  })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    yield* waitForDetached(10)
    expect(upgrades).toEqual([
      {
        url: "wss://rika.test/sessions/session/ws",
        headers: {
          authorization: "DPoP access",
          dpop: "proof-GET-wss://rika.test/sessions/session/ws",
        },
      },
      {
        url: "wss://rika.test/sessions/session/ws?cursor=4",
        headers: {
          authorization: "DPoP access",
          dpop: "proof-GET-wss://rika.test/sessions/session/ws?cursor=4",
        },
      },
    ])
    yield* client.dispose
  })
})

it.effect("does not publish a command receipt after switching to another Thread", () => {
  const started = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const calls = { a: 0, b: 0 }
  const snapshotFor = (sessionId: string): GeneralistSnapshot =>
    ({
      ...snapshot,
      session: { ...snapshot.session, id: sessionId, activeRunId: undefined },
      runs: [],
    }) as unknown as GeneralistSnapshot
  const connectionFor = (sessionId: string) => ({
    snapshot: snapshotFor(sessionId),
    events: Stream.empty,
    status: Stream.empty,
    exhausted: Effect.never,
    cancel: () => Effect.void,
  })
  const makeExecution = (id: "a" | "b"): ExecutionClient =>
    ({
      raw: {},
      snapshot: () => Effect.succeed(snapshotFor(`${id}-session`)),
      history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
      family: () => Effect.succeed({ rootSessionId: `${id}-session`, at: 0, sessions: [], nextBefore: null }),
      submit: () =>
        id === "a"
          ? Effect.sync(() => {
              calls.a += 1
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as({ id: "a-receipt", revision: 1 }),
            )
          : Effect.sync(() => {
              calls.b += 1
              return { id: "b-receipt", revision: 1 }
            }),
      updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
      removeInput: () => Effect.succeed({ id: "pending", revision: 2 }),
      steer: () => Effect.void,
      cancel: () => Effect.void,
      control: () => Effect.void,
      runs: () => Effect.succeed([]),
      connect: ({ sessionId }: { readonly sessionId: string }) => Effect.succeed(connectionFor(sessionId)),
      subscribe: () => Stream.empty,
    }) as unknown as ExecutionClient
  const productForSwitch: ProductClient = {
    identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
    listThreads: () =>
      Effect.succeed({
        threads: [
          { id: "a", title: "A", target: "runner" as const },
          { id: "b", title: "B", target: "runner" as const },
        ],
        nextCursor: null,
      }),
    thread: (id) => Effect.succeed({ id, title: id.toUpperCase(), target: "runner" as const }),
    access: (threadId) => Effect.succeed({ threadId, role: "controller" as const }),
    catalog: Effect.succeed({ modes: [] }),
    ensureSession: (threadId) => Effect.succeed({ sessionId: `${threadId}-session`, created: false }),
  }
  const client = makeThreadClient({
    product: productForSwitch,
    execution: makeExecution("a"),
    executionForThread: (thread) => Effect.succeed(makeExecution(thread.id as "a" | "b")),
    webSocketConstructor: () => ({}) as WebSocket,
  })
  return Effect.gen(function* () {
    yield* client.selectThread("a")
    const submit = yield* client.submit("old partition").pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* client.selectThread("b")
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(submit).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.kind).toBe("selection")
    expect(calls).toEqual({ a: 1, b: 0 })
    expect(client.state.selectedThreadId).toBe("b")
    expect(client.state.lastReceipt).toBeUndefined()
    yield* client.dispose
  })
})

it.effect("closes owned connection fibers when disposed during connect", () => {
  let interrupted = 0
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(snapshot),
    history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "new", revision: 1 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    steer: () => Effect.void,
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.ensuring(Effect.never, Effect.sync(() => (interrupted += 1))),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    yield* waitForDetached(10)
    yield* client.dispose
    expect(interrupted).toBe(1)
  })
})
