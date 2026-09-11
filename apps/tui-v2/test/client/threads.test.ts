/* oxlint-disable anti-slop/no-chained-type-assertions -- client adapter tests narrow minimal transport doubles. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures intentionally stand in for released transport values. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- fixture transport values are checked by the adapter assertions. */
/* oxlint-disable effecttsgo/global-timers-in-effect -- native timers let this test await ManagedRuntime fork completion under @effect/vitest. */
/* oxlint-disable effecttsgo/global-date-in-effect -- polling detached fibers needs wall-clock deadlines, not the frozen test Clock. */
/* oxlint-disable effecttsgo/new-promise -- native timer bridge is the test's asynchronous observation boundary. */
/* oxlint-disable eslint(no-promise-executor-return) -- the timer callback intentionally returns the timeout handle. */
/* oxlint-disable effecttsgo/strict-effect-provide -- these tests supply deterministic platform services at their boundary. */
/* oxlint-disable max-lines -- Thread creation, seeding, startup prompt, and catalog scope coverage stay mirrored in one focused suite. */
import { expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Deferred, Effect, FileSystem, Stream } from "effect"
import { ExecutableManifest } from "generalist"
import type { ExecutionClient, GeneralistSnapshot } from "@rika/client/generalist"
import { ProductClientError, type ProductClient, type ThreadMetadata } from "@rika/client/product"
import type { WorkspaceSeedClient } from "@rika/client/workspace-seeds"
import { createThreadClient, type ThreadCreationOptions } from "../../src/client/threads"

const snapshot = {
  version: 1,
  session: {
    id: "session",
    title: "Thread TUI",
    createdAt: "2026-09-09T00:00:00.000Z",
    queue: [],
    activeRunId: "run",
  },
  cursor: 0,
  runs: [{ runId: "run", rootRunId: "run", status: "running", cursor: 0, turn: 1 }],
  conversation: { leafId: null, entries: [] },
} as unknown as GeneralistSnapshot

const executable = ExecutableManifest.makeTest("thread-client")("agent")

const product = (): ProductClient => ({
  identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
  listThreads: () =>
    Effect.succeed({ threads: [{ id: "thread", title: "Thread", target: "runner" }], nextCursor: null }),
  thread: () => Effect.succeed({ id: "thread", title: "Thread", target: "runner" }),
  access: () => Effect.succeed({ threadId: "thread", role: "controller" }),
  catalog: Effect.succeed({ modes: [] }),
  createThread: () => Effect.die("Thread creation is not used by this fixture"),
  archiveThread: () => Effect.die("Thread archive is not used by this fixture"),
  ensureSession: () => Effect.succeed({ sessionId: "session", created: false }),
})

const waitForDetached = (millis: number) =>
  Effect.callback<void>((resume) => {
    // ast-grep-ignore: effect-prefer-scheduling -- this fixture waits for a detached ManagedRuntime fiber.
    const timer = setTimeout(() => resume(Effect.void), millis)
    return Effect.sync(() => clearTimeout(timer))
  })

/**
 * Poll a condition against detached-fiber progress. Real Workspace staging spawns `git`/`rg`/`tar`, so a fixed
 * sleep flakes under load; bounded polling keeps fast paths fast while still failing on a real regression.
 */
const waitForDetachedUntil = (condition: () => boolean, timeoutMillis = 10_000) =>
  Effect.gen(function* () {
    // ast-grep-ignore: effect-prefer-clock -- detached-fiber polling needs wall-clock time, not the frozen test Clock.
    const deadline = Date.now() + timeoutMillis
    while (!condition()) {
      // ast-grep-ignore: effect-prefer-clock -- detached-fiber polling needs wall-clock time, not the frozen test Clock.
      if (Date.now() >= deadline) return
      yield* waitForDetached(25)
    }
  })

const seedWorkspace = Effect.fn("TuiV2.ThreadsTest.seedWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const workspace = yield* fileSystem.makeTempDirectory({ prefix: "rika-tui-v2-threads-" })
  yield* fileSystem.writeFileString(`${workspace}/seeded.txt`, "local workspace contents\n")
  return workspace
})

const seedStage =
  (
    staged: Parameters<WorkspaceSeedClient["stage"]>[0][],
    stage?: WorkspaceSeedClient["stage"],
  ): WorkspaceSeedClient["stage"] =>
  (input) =>
    Effect.suspend(() => {
      staged.push(input)
      return stage?.(input) ?? Effect.succeed({ workspaceSeedId: "workspace-seed-fixture" })
    })

const creationFixture = (
  options: {
    readonly create?: ProductClient["createThread"]
    readonly archive?: ProductClient["archiveThread"]
    readonly creation?: ThreadCreationOptions
    readonly initialThreads?: readonly ThreadMetadata[]
    readonly initialPrompt?: string
    readonly workspace?: string
    readonly stage?: WorkspaceSeedClient["stage"]
    readonly executionForThread?: (
      thread: ThreadMetadata,
      execution: ExecutionClient,
    ) => Effect.Effect<ExecutionClient, never>
  } = {},
) => {
  const requests: Parameters<ProductClient["createThread"]>[0][] = []
  const archives: string[] = []
  const factoryCalls: string[] = []
  const stagedSeeds: Parameters<WorkspaceSeedClient["stage"]>[0][] = []
  const submittedPrompts: string[] = []
  const listInputs: unknown[] = []
  const threads: ThreadMetadata[] = [
    ...(options.initialThreads ?? [
      { id: "thread", title: "Current Thread", target: "runner" },
      { id: "other", title: "Other Thread", target: "runner" },
    ]),
  ]
  const clientProduct: ProductClient = {
    ...product(),
    listThreads: (input) => {
      listInputs.push(input)
      return Effect.succeed({ threads: [...threads], nextCursor: null })
    },
    thread: (id) => {
      const thread = threads.find((candidate) => candidate.id === id)
      return thread === undefined ? Effect.die("Unknown fixture Thread") : Effect.succeed(thread)
    },
    createThread: (request) => {
      requests.push(request)
      return (options.create?.(request) ?? Effect.succeed({ threadId: request.threadId })).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (request.archiveThreadId !== undefined) {
              const archived = threads.findIndex((thread) => thread.id === request.archiveThreadId)
              if (archived >= 0) threads.splice(archived, 1)
            }
            if (!threads.some((thread) => thread.id === request.threadId))
              threads.push({ id: request.threadId, title: "Created Thread", target: request.target })
          }),
        ),
      )
    },
    archiveThread: (threadId) => {
      archives.push(threadId)
      return (options.archive?.(threadId) ?? Effect.succeed({ threadId, archived: true as const })).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const archived = threads.findIndex((thread) => thread.id === threadId)
            if (archived >= 0) threads.splice(archived, 1)
          }),
        ),
      )
    },
    ensureSession: (threadId) => Effect.succeed({ sessionId: `${threadId}-session`, created: false }),
  }
  const snapshotFor = (sessionId: string) => ({ ...snapshot, session: { ...snapshot.session, id: sessionId } })
  const unused = () => Effect.die("Thread creation must not submit, cancel, or mutate a Run")
  const execution = {
    raw: {},
    snapshot: ({ sessionId }: { readonly sessionId: string }) => Effect.succeed(snapshotFor(sessionId)),
    history: unused,
    family: ({ sessionId }: { readonly sessionId: string }) =>
      Effect.succeed({ rootSessionId: sessionId, at: 0, sessions: [], nextBefore: null }),
    submit: ({ input }: { readonly input: string }) =>
      Effect.sync(() => {
        submittedPrompts.push(input)
        return { id: "receipt", revision: 1 }
      }),
    updateInput: unused,
    removeInput: unused,
    steer: unused,
    cancel: unused,
    control: unused,
    runs: () => Effect.succeed([]),
    connect: ({ sessionId }: { readonly sessionId: string }) =>
      Effect.succeed({
        snapshot: snapshotFor(sessionId),
        events: Stream.empty,
        status: Stream.empty,
        exhausted: Effect.never,
        cancel: () => Effect.void,
      }),
    subscribe: () => Stream.empty,
  } as unknown as ExecutionClient
  const executionForThread = options.executionForThread
  const clientOptions = {
    product: clientProduct,
  }
  const threadClientOptions: Parameters<typeof createThreadClient>[0] =
    executionForThread === undefined
      ? { ...clientOptions, execution }
      : {
          ...clientOptions,
          executionForThread: (thread) => {
            factoryCalls.push(thread.id)
            return executionForThread(thread, execution)
          },
        }
  if (options.creation !== undefined) Object.assign(threadClientOptions, { creation: options.creation })
  if (options.workspace !== undefined) {
    Object.assign(threadClientOptions, {
      workspace: options.workspace,
      workspaceSeeds: { stage: seedStage(stagedSeeds, options.stage) },
    })
  }
  if (options.initialPrompt !== undefined) Object.assign(threadClientOptions, { initialPrompt: options.initialPrompt })
  const client = createThreadClient(threadClientOptions)
  return { client, factoryCalls, requests, archives, threads, stagedSeeds, submittedPrompts, listInputs }
}

it.effect("creates the first Box Thread and selects it through its execution factory", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace()
    const test = creationFixture({
      initialThreads: [],
      workspace,
      executionForThread: (_thread, execution) => Effect.succeed(execution),
    })
    yield* waitForDetached(30)
    expect(test.client.state.threads).toEqual([])
    expect(test.factoryCalls).toEqual([])
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.requests.length === 1)
    const created = test.requests[0]
    expect(created).toBeDefined()
    expect(test.stagedSeeds).toHaveLength(1)
    expect(test.stagedSeeds[0]?.archive.content.length).toBeGreaterThan(0)
    expect(created).toMatchObject({ target: "orb", workspaceSeedId: "workspace-seed-fixture" })
    expect(test.factoryCalls).toEqual([created?.threadId])
    expect(test.client.state.selectedThreadId).toBe(created?.threadId)
    expect(test.client.state.threads).toHaveLength(1)
    expect(test.client.state.threads[0]?.target).toBe("orb")
    yield* test.client.dispose
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("does not create a Box Thread when Workspace staging fails and restages its stable identity on retry", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace()
    let attempts = 0
    const test = creationFixture({
      initialThreads: [],
      workspace,
      stage: () => {
        attempts += 1
        return attempts === 1
          ? ProductClientError.make({ kind: "network", message: "Workspace staging is unavailable" })
          : Effect.succeed({ workspaceSeedId: "workspace-seed-retry" })
      },
      executionForThread: (_thread, execution) => Effect.succeed(execution),
    })
    yield* waitForDetached(30)
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.stagedSeeds.length === 1)
    expect(test.stagedSeeds).toHaveLength(1)
    expect(test.requests).toEqual([])
    expect(test.client.state.notice).toContain("Workspace staging is unavailable")
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.requests.length === 1)
    expect(test.stagedSeeds).toHaveLength(2)
    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]).toMatchObject({ target: "orb", workspaceSeedId: "workspace-seed-retry" })
    yield* test.client.dispose
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("refuses a Box Thread without Workspace seed staging instead of falling back", () =>
  Effect.gen(function* () {
    const test = creationFixture({ initialThreads: [] })
    yield* waitForDetached(30)
    test.client.newThread("orb")
    yield* waitForDetached(50)
    expect(test.stagedSeeds).toEqual([])
    expect(test.requests).toEqual([])
    expect(test.client.state.notice).toContain("Workspace")
    yield* test.client.dispose
  }),
)

it.effect("submits the initial prompt after the startup Thread selection completes", () =>
  Effect.gen(function* () {
    const test = creationFixture({
      initialThreads: [{ id: "thread", title: "Startup Thread", target: "runner" }],
      initialPrompt: "continue the migration",
      executionForThread: (_thread, execution) => Effect.succeed(execution),
    })
    yield* waitForDetachedUntil(() => test.submittedPrompts.length === 1)
    expect(test.client.state.selectedThreadId).toBe("thread")
    expect(test.submittedPrompts).toEqual(["continue the migration"])
    yield* test.client.dispose
  }),
)

it.effect("does not submit the initial prompt when the user navigates during the startup selection", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const test = creationFixture({
      initialThreads: [
        { id: "thread", title: "Startup Thread", target: "runner" },
        { id: "other", title: "Other Thread", target: "runner" },
      ],
      initialPrompt: "continue the migration",
      executionForThread: (thread, execution) =>
        thread.id === "thread" ? Deferred.await(gate).pipe(Effect.as(execution)) : Effect.succeed(execution),
    })
    yield* waitForDetachedUntil(() => test.factoryCalls.length === 1)
    expect(test.factoryCalls).toEqual(["thread"])
    test.client.selectThread("other")
    yield* waitForDetached(50)
    yield* Deferred.succeed(gate, undefined)
    yield* waitForDetachedUntil(() => test.client.state.selectedThreadId === "other")
    expect(test.client.state.selectedThreadId).toBe("other")
    expect(test.submittedPrompts).toEqual([])
    yield* test.client.dispose
  }),
)

it.effect("creates and selects Threads with the owning machine or Box options without submitting work", () =>
  Effect.gen(function* () {
    const cases: { readonly target: "runner" | "orb"; readonly creation: ThreadCreationOptions }[] = [
      {
        target: "runner",
        creation: {
          owner: { kind: "organization", organization_id: "organization" },
          projectId: "project",
          runnerTarget: { deviceId: "device", checkoutFingerprint: "checkout" },
        },
      },
      { target: "orb", creation: { owner: { kind: "personal" } } },
    ]
    for (const input of cases) {
      const workspace = yield* seedWorkspace()
      const test = creationFixture({ creation: input.creation, workspace })
      yield* waitForDetached(30)
      test.client.newThread(input.target)
      yield* waitForDetachedUntil(() => test.requests.length === 1)
      expect(test.requests).toHaveLength(1)
      expect(test.requests[0]).toMatchObject({ ...input.creation, target: input.target })
      if (input.target === "orb") {
        expect(test.stagedSeeds).toHaveLength(1)
        expect(test.stagedSeeds[0]?.owner).toEqual(input.creation.owner)
        expect(test.requests[0]).toMatchObject({ workspaceSeedId: "workspace-seed-fixture" })
      }
      expect(test.client.state.selectedThreadId).toBe(test.requests[0]?.threadId)
      expect(test.client.state.threads.find((thread) => thread.id === test.requests[0]?.threadId)?.target).toBe(
        input.target,
      )
      yield* test.client.dispose
    }
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("reuses the same Thread identity after an ambiguous creation failure", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace()
    let attempts = 0
    const test = creationFixture({
      workspace,
      create: ({ threadId }) => {
        attempts += 1
        return attempts === 1
          ? ProductClientError.make({ kind: "network", message: "Response was lost" })
          : Effect.succeed({ threadId })
      },
    })
    yield* waitForDetached(30)
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.stagedSeeds.length === 1 && test.client.state.notice.includes("Response was lost"))
    expect(test.client.state.notice).toContain("Response was lost")
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.requests.length === 2)
    expect(test.requests).toHaveLength(2)
    expect(test.requests[1]).toEqual(test.requests[0])
    expect(test.stagedSeeds).toHaveLength(1)
    expect(test.threads.filter((thread) => thread.id === test.requests[0]?.threadId)).toHaveLength(1)
    expect(test.client.state.selectedThreadId).toBe(test.requests[0]?.threadId)
    yield* test.client.dispose
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("coalesces creation clicks and preserves a later explicit Thread selection", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace()
    const gate = yield* Deferred.make<void>()
    const test = creationFixture({
      workspace,
      create: ({ threadId }) => Deferred.await(gate).pipe(Effect.as({ threadId })),
    })
    yield* waitForDetached(30)
    test.client.newThread("orb")
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.requests.length === 1)
    expect(test.requests).toHaveLength(1)
    test.client.selectThread("other")
    yield* waitForDetached(30)
    yield* Deferred.succeed(gate, undefined)
    yield* waitForDetachedUntil(() => test.client.state.selectedThreadId === "other")
    expect(test.client.state.selectedThreadId).toBe("other")
    expect(test.client.state.threads.some((thread) => thread.id === test.requests[0]?.threadId)).toBe(true)
    yield* test.client.dispose
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("does not turn a missing local Runner into a Box implicitly", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace()
    const test = creationFixture({ workspace })
    yield* waitForDetached(30)
    test.client.newThread()
    yield* waitForDetached(30)
    expect(test.requests).toEqual([])
    expect(test.client.state.notice).toContain("No local Runner is registered")
    test.client.newThread("orb")
    yield* waitForDetachedUntil(() => test.requests.length === 1)
    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]).toMatchObject({ target: "orb", workspaceSeedId: "workspace-seed-fixture" })
    yield* test.client.dispose
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("scopes the Thread catalog listing to the selected owner and project", () =>
  Effect.gen(function* () {
    const test = creationFixture({
      creation: {
        owner: { kind: "organization", organization_id: "organization" },
        projectId: "project",
        runnerTarget: { deviceId: "device", checkoutFingerprint: "checkout" },
      },
    })
    yield* waitForDetached(50)
    expect(test.listInputs.length).toBeGreaterThan(0)
    expect(test.listInputs[0]).toMatchObject({
      scope: { owner: { kind: "organization", organization_id: "organization" }, projectId: "project" },
    })
    yield* test.client.dispose
  }),
)

it.effect("routes Thread follow-up, stop, and cancel controls to the canonical client", () => {
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
  const client = createThreadClient({
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

it.effect("keeps connections connected and rejects unsupported images before enqueue", () => {
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
  const client = createThreadClient({
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
    expect(client.state.notice).toBe("Image attachments are not supported by this transport")
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
  const client = createThreadClient({
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

it.effect("loads an older history page through the public TUI client", () => {
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
  const client = createThreadClient({
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
import "./threads-startup.harness"
