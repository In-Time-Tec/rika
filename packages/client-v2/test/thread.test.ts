/* oxlint-disable typescript/no-unsafe-type-assertion -- the fixture intentionally narrows a transport double to the public client surface. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- transport doubles are intentionally narrowed in these focused tests. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- transport doubles use one boundary assertion for the public client surface. */
/* oxlint-disable effecttsgo/global-timers-in-effect -- detached connection tests need a bounded scheduler turn. */
/* oxlint-disable effecttsgo/new-promise -- detached connection tests need a bounded scheduler turn. */
/* oxlint-disable max-lines -- focused transport tests cover paging, reconnect, and retained-session selection together. */
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Socket from "effect/unstable/socket/Socket"
import { ExecutableManifest } from "generalist"
import { Server, type ConnectionEvent } from "generalist/server"
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
  listThreads: () =>
    Effect.succeed({ threads: [{ id: "thread", title: "Hosted", target: "runner" }], nextCursor: null }),
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

const conversationEntry = (id: string, parentId: string | null, text = id) => ({
  id,
  parentId,
  messages: [Prompt.makeMessage("assistant", { content: [Prompt.makePart("text", { text })] })],
})

const snapshotWithConversation = (conversation: GeneralistSnapshot["conversation"]): GeneralistSnapshot =>
  Schema.decodeSync(Server.SessionSnapshot)({ ...snapshot, conversation })

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
    family: () =>
      Effect.succeed({
        rootSessionId: "session",
        at: 0,
        sessions: [
          {
            id: "retained-child-session",
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
    yield* client.openChildSession("retained-child-session")
    yield* client.followUp("continue child", "retained-child-session")
    yield* client.cancel("cancel-command", "stop now")
    yield* client.stop("stop-command")
    expect(calls.submit).toEqual(["retained-child-session"])
    expect(calls.cancel).toEqual(["run"])
    expect(calls.control).toEqual(["stop"])
    yield* client.dispose
  })
})

it.effect("pages retained family membership with a bounded, epoch-safe cursor", () => {
  type FamilyCall = {
    readonly sessionId: string
    readonly at?: number
    readonly before?: number
    readonly limit: number
  }
  const familyCalls: FamilyCall[] = []
  const pages = [
    {
      rootSessionId: "session",
      at: 42,
      sessions: [
        {
          id: "first-child",
          rootSessionId: "session",
          parentSessionId: "session",
          parentRunId: "run",
          initialRunId: "first-run",
          depth: 1,
        },
      ],
      nextBefore: 100,
    },
    { rootSessionId: "session", at: 42, sessions: [], nextBefore: 90 },
    {
      rootSessionId: "session",
      at: 42,
      sessions: [
        {
          id: "last-child",
          rootSessionId: "session",
          parentSessionId: "session",
          parentRunId: "run",
          initialRunId: "last-run",
          depth: 1,
        },
      ],
      nextBefore: null,
    },
  ]
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
    family: (input: FamilyCall) =>
      Effect.sync(() => {
        familyCalls.push(input)
        return pages.shift()!
      }),
    submit: ({ sessionId }: { readonly sessionId: string }) => Effect.succeed({ id: sessionId, revision: 1 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 2 }),
    steer: () => Effect.void,
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    expect(familyCalls).toEqual([{ sessionId: "session", limit: 64 }])
    expect(client.state.projection?.family?.at).toBe(42)
    const unknown = yield* Effect.result(client.openChildSession("missing-child"))
    expect(unknown._tag).toBe("Failure")
    yield* client.loadMoreCollaborators(2)
    yield* client.loadMoreCollaborators(2)
    yield* client.loadMoreCollaborators(2)
    expect(familyCalls).toEqual([
      { sessionId: "session", limit: 64 },
      { sessionId: "session", at: 42, before: 100, limit: 2 },
      { sessionId: "session", at: 42, before: 90, limit: 2 },
    ])
    expect(client.state.projection?.family?.at).toBe(42)
    expect(client.state.projection?.family?.sessions.map((session) => session.id)).toEqual([
      "first-child",
      "last-child",
    ])
    expect(
      client.state.projection?.thread.items.filter((item) => item.kind === "child").map((item) => item.id),
    ).toEqual(["child-session:first-child", "child-session:last-child"])
    yield* client.dispose
  })
})

it.effect("opens a retained child lazily while preserving root and child history cursors", () => {
  const rootSnapshot = snapshotWithConversation({
    leafId: "root-latest",
    entries: [conversationEntry("root-current", "root-anchor")],
    nextLeafId: "root-anchor",
  })
  const childSnapshot = Schema.decodeSync(Server.SessionSnapshot)({
    ...rootSnapshot,
    session: { ...rootSnapshot.session, id: "child-session", title: "Child" },
    conversation: {
      leafId: "child-latest",
      entries: [conversationEntry("child-current", "child-anchor")],
      nextLeafId: "child-anchor",
    },
  })
  const snapshots: string[] = []
  const histories: Array<{ readonly sessionId: string; readonly leafId: string }> = []
  const family = {
    rootSessionId: "session",
    at: 1,
    sessions: [
      {
        id: "child-session",
        rootSessionId: "session",
        parentSessionId: "session",
        parentRunId: "run",
        initialRunId: "child-run",
        depth: 1,
      },
    ],
    nextBefore: null,
  }
  const connection = {
    snapshot: rootSnapshot,
    events: Stream.empty,
    status: Stream.empty,
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: ({ sessionId }: { readonly sessionId: string }) =>
      Effect.sync(() => {
        snapshots.push(sessionId)
        return sessionId === "session" ? rootSnapshot : childSnapshot
      }),
    history: ({ sessionId, leafId }: { readonly sessionId: string; readonly leafId: string }) =>
      Effect.sync(() => {
        histories.push({ sessionId, leafId })
        return sessionId === "session"
          ? { leafId: "root-anchor", entries: [conversationEntry("root-older", null)], nextLeafId: null }
          : { leafId: "child-anchor", entries: [conversationEntry("child-older", null)], nextLeafId: null }
      }),
    family: () => Effect.succeed(family),
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
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    expect(snapshots).toEqual(["session"])
    yield* client.loadOlder()
    yield* client.openChildSession("child-session")
    expect(snapshots).toEqual(["session", "child-session"])
    expect(client.state.selectedThreadId).toBe("thread")
    expect(client.state.focusedSessionId).toBe("child-session")
    yield* client.loadOlder()
    expect(histories).toEqual([
      { sessionId: "session", leafId: "root-anchor" },
      { sessionId: "child-session", leafId: "child-anchor" },
    ])
    yield* client.backToThread()
    expect(client.state.focusedSessionId).toBeUndefined()
    yield* client.openChildSession("child-session")
    expect(snapshots).toEqual(["session", "child-session"])
    expect(client.state.projection?.snapshot.conversation.entries.map((entry) => entry.id)).toEqual([
      "child-older",
      "child-current",
    ])
    yield* client.dispose
  })
})

it.effect("refreshes family membership on reconnect without changing Thread selection", () => {
  const familyCalls: number[] = []
  const oldChild = {
    id: "old-child",
    rootSessionId: "session",
    parentSessionId: "session",
    parentRunId: "run",
    initialRunId: "old-run",
    depth: 1,
  }
  const newChild = { ...oldChild, id: "new-child", initialRunId: "new-run" }
  const initialFamily = { rootSessionId: "session", at: 1, sessions: [oldChild], nextBefore: null }
  const refreshedFamily = { rootSessionId: "session", at: 2, sessions: [newChild], nextBefore: null }
  const connection = {
    snapshot,
    events: Stream.empty,
    status: Stream.succeed({ _tag: "Retrying" as const, epoch: 1, attempt: 1 }),
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(snapshot),
    history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
    family: () =>
      Effect.sync(() => {
        familyCalls.push(1)
        return familyCalls.length === 1 ? initialFamily : refreshedFamily
      }),
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
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    yield* client.openChildSession("old-child")
    yield* waitForDetached(25)
    expect(familyCalls).toHaveLength(2)
    expect(client.state.selectedThreadId).toBe("thread")
    expect(client.state.focusedSessionId).toBeUndefined()
    expect(client.state.projection?.family?.sessions.map((session) => session.id)).toEqual(["new-child"])
    const removed = yield* Effect.result(client.openChildSession("old-child"))
    expect(removed._tag).toBe("Failure")
    const staleFollowUp = yield* Effect.result(client.followUp("stale", "old-child"))
    expect(staleFollowUp._tag).toBe("Failure")
    yield* client.openChildSession("new-child")
    const followUp = yield* client.followUp("current", "new-child")
    expect(followUp.status).toBe("accepted")
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
    connect: () =>
      Effect.ensuring(
        Effect.never,
        Effect.sync(() => (interrupted += 1)),
      ),
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

it.effect("merges an in-flight history page into the current cursor and preserves events and previews", () => {
  const currentSnapshot = snapshotWithConversation({
    leafId: "latest",
    entries: [conversationEntry("current", "anchor")],
    nextLeafId: "anchor",
  })
  const pageStarted = Deferred.makeUnsafe<void>()
  const releasePage = Deferred.makeUnsafe<void>()
  const events = Effect.runSync(Queue.unbounded<ConnectionEvent>())
  const historyCalls: string[] = []
  const page = {
    leafId: "anchor",
    entries: [conversationEntry("older", "root")],
    nextLeafId: null,
  }
  const connection = {
    snapshot: currentSnapshot,
    events: Stream.fromQueue(events),
    status: Stream.empty,
    exhausted: Effect.never,
    cancel: () => Effect.void,
  }
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(currentSnapshot),
    history: ({ leafId }: { readonly leafId: string }) =>
      Effect.sync(() => {
        historyCalls.push(leafId)
      }).pipe(
        Effect.andThen(Deferred.succeed(pageStarted, undefined)),
        Effect.andThen(Deferred.await(releasePage)),
        Effect.as(page),
      ),
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "new", revision: 5 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    steer: () => Effect.void,
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () => Effect.succeed(connection),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    const paging = yield* client.loadOlder().pipe(Effect.forkChild)
    yield* Deferred.await(pageStarted)
    yield* Queue.offer(events, {
      _tag: "Conversation",
      sessionId: "session",
      cursor: 1,
      update: {
        previousLeafId: "latest",
        leafId: "newest",
        afterEntryId: "current",
        entries: [conversationEntry("append", "current")],
      },
    })
    yield* Queue.offer(events, {
      _tag: "PreviewDelivery",
      sessionId: "session",
      runId: "run",
      authorityAttemptFence: 1,
      event: {
        _tag: "ModelPreview",
        runId: "run",
        attemptFence: 1,
        turn: 1,
        modelCallId: "model-call",
        modelAttemptId: "model-attempt",
        attempt: 1,
        generation: 1,
        sequence: 1,
        changes: [{ channel: "text", offset: 0, delta: "preview" }],
      },
    })
    yield* waitForDetached(10)
    yield* Deferred.succeed(releasePage, undefined)
    yield* Fiber.join(paging)
    expect(historyCalls).toEqual(["anchor"])
    expect(client.state.projection?.snapshot.cursor).toBe(1)
    expect(client.state.projection?.snapshot.conversation.leafId).toBe("newest")
    expect(client.state.projection?.snapshot.conversation.nextLeafId).toBeUndefined()
    expect(client.state.projection?.snapshot.conversation.entries.map((entry) => entry.id)).toEqual([
      "older",
      "current",
      "append",
    ])
    expect(client.state.projection?.previews.get("run")?.text).toBe("preview")
    yield* client.loadOlder()
    expect(historyCalls).toEqual(["anchor"])
    yield* client.dispose
  })
})

it.effect("rejects a history page whose anchor was invalidated by selection", () => {
  const pageStarted = Deferred.makeUnsafe<void>()
  const releasePage = Deferred.makeUnsafe<void>()
  const historySnapshot = snapshotWithConversation({
    leafId: "latest",
    entries: [conversationEntry("current", "anchor")],
    nextLeafId: "anchor",
  })
  const execution = {
    raw: {},
    snapshot: () => Effect.succeed(historySnapshot),
    history: () =>
      Effect.void.pipe(
        Effect.andThen(Deferred.succeed(pageStarted, undefined)),
        Effect.andThen(Deferred.await(releasePage)),
        Effect.as({ leafId: "anchor", entries: [], nextLeafId: null }),
      ),
    family: () => Effect.succeed({ rootSessionId: "session", at: 0, sessions: [], nextBefore: null }),
    submit: () => Effect.succeed({ id: "new", revision: 5 }),
    updateInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    removeInput: () => Effect.succeed({ id: "pending", revision: 5 }),
    steer: () => Effect.void,
    cancel: () => Effect.void,
    control: () => Effect.void,
    runs: () => Effect.succeed([]),
    connect: () =>
      Effect.succeed({
        snapshot: historySnapshot,
        events: Stream.empty,
        status: Stream.empty,
        exhausted: Effect.never,
        cancel: () => Effect.void,
      }),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const client = makeThreadClient({ product: product(), execution, webSocketConstructor: () => ({}) as WebSocket })
  return Effect.gen(function* () {
    yield* client.selectThread("thread")
    const paging = yield* client.loadOlder().pipe(Effect.forkChild)
    yield* Deferred.await(pageStarted)
    yield* client.selectThread("other")
    yield* Deferred.succeed(releasePage, undefined)
    const result = yield* Fiber.join(paging).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.kind).toBe("selection")
    expect(client.state.selectedThreadId).toBe("other")
    yield* client.dispose
  })
})
