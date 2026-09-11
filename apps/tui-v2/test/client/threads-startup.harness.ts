/* oxlint-disable effecttsgo/global-timers-in-effect -- native timers let this harness await ManagedRuntime fork completion under @effect/vitest. */
/* oxlint-disable effecttsgo/global-date-in-effect -- polling detached fibers needs wall-clock deadlines, not the frozen test Clock. */
/* oxlint-disable effecttsgo/new-promise -- native timer bridge is the harness's asynchronous observation boundary. */
/* oxlint-disable eslint(no-promise-executor-return) -- the timer callback intentionally returns the timeout handle. */
/* oxlint-disable effecttsgo/strict-effect-provide -- this harness supplies deterministic platform services at its boundary. */
import { expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Deferred, Effect, FileSystem } from "effect"
import { ProductClientError, type ProductClient, type ThreadMetadata } from "@rika/client/product"
import { createThreadClient } from "../../src/client/threads"

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

const archiveFixture = (
  input: {
    readonly create?: ProductClient["createThread"]
    readonly archive?: ProductClient["archiveThread"]
    readonly runner?: boolean
  } = {},
) => {
  const requests: Parameters<ProductClient["createThread"]>[0][] = []
  const archives: string[] = []
  const threads: ThreadMetadata[] = [
    { id: "thread", title: "Current Thread", target: "runner" },
    { id: "other", title: "Other Thread", target: "runner" },
  ]
  const clientOptions: Parameters<typeof createThreadClient>[0] = {
    product: {
      ...product(),
      listThreads: () => Effect.succeed({ threads: [...threads], nextCursor: null }),
      thread: (threadId) => {
        const thread = threads.find((candidate) => candidate.id === threadId)
        return thread === undefined
          ? ProductClientError.make({ kind: "protocol", message: "Thread is unavailable", status: 404 })
          : Effect.succeed(thread)
      },
      createThread: (request) => {
        requests.push(request)
        return (input.create?.(request) ?? Effect.succeed({ threadId: request.threadId })).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (request.archiveThreadId !== undefined) {
                const archived = threads.findIndex((thread) => thread.id === request.archiveThreadId)
                if (archived >= 0) threads.splice(archived, 1)
              }
              threads.push({ id: request.threadId, title: "Replacement Thread", target: request.target })
            }),
          ),
        )
      },
      archiveThread: (threadId) => {
        archives.push(threadId)
        return input.archive?.(threadId) ?? Effect.succeed({ threadId, archived: true as const })
      },
    },
    executionForThread: () => Effect.die("Archive controls must not request a Runtime before their navigation fence"),
  }
  if (input.runner !== false)
    Object.assign(clientOptions, {
      creation: {
        owner: { kind: "personal" as const },
        runnerTarget: { deviceId: "device", checkoutFingerprint: "checkout" },
      },
    })
  const client = createThreadClient(clientOptions)
  return { client, requests, archives, threads }
}

const settle = () => Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow))

const waitForDetached = (millis: number) =>
  Effect.callback<void>((resume) => {
    // ast-grep-ignore: effect-prefer-scheduling -- this harness waits for a detached ManagedRuntime fiber.
    const timer = setTimeout(() => resume(Effect.void), millis)
    return Effect.sync(() => clearTimeout(timer))
  })

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

const seedWorkspace = Effect.fn("TuiV2.ThreadsStartupTest.seedWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const workspace = yield* fileSystem.makeTempDirectory({ prefix: "rika-tui-v2-startup-" })
  yield* fileSystem.writeFileString(`${workspace}/seeded.txt`, "local workspace contents\n")
  return workspace
})

it.effect("keeps an empty online account free of execution and Session transport", () =>
  Effect.gen(function* () {
    const calls = { list: 0, archive: 0, thread: 0, ensureSession: 0, executionFactory: 0 }
    const client = createThreadClient({
      product: {
        ...product(),
        listThreads: () => {
          calls.list += 1
          return Effect.succeed({ threads: [], nextCursor: null })
        },
        archiveThread: () => {
          calls.archive += 1
          return Effect.succeed({ threadId: "unexpected", archived: true as const })
        },
        thread: (threadId) => {
          calls.thread += 1
          return Effect.succeed({ id: threadId, title: "Unexpected Thread", target: "runner" })
        },
        ensureSession: () => {
          calls.ensureSession += 1
          return Effect.succeed({ sessionId: "unexpected-session", created: false })
        },
      },
      executionForThread: () => {
        calls.executionFactory += 1
        return Effect.die("An empty account must not create execution")
      },
    })
    yield* Effect.yieldNow
    expect(client.state.threads).toEqual([])
    expect(client.state.selectedThreadId).toBe("")
    expect(calls).toEqual({ list: 1, archive: 0, thread: 0, ensureSession: 0, executionFactory: 0 })
    let quit = 0
    client.archiveThread(() => {
      quit += 1
    })
    client.archiveAndNewThread(() => {
      quit += 1
    })
    yield* settle()
    expect(calls.archive).toBe(0)
    expect(quit).toBe(0)
    expect(client.state.notice).toContain("Select a Thread before archiving")
    yield* client.dispose
  }),
)

it.effect("keeps an empty account empty when Thread creation fails", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace()
    let creations = 0
    let executionFactoryCalls = 0
    const client = createThreadClient({
      product: {
        ...product(),
        listThreads: () => Effect.succeed({ threads: [], nextCursor: null }),
        createThread: () => {
          creations += 1
          return ProductClientError.make({ kind: "forbidden", message: "Thread creation was denied", status: 403 })
        },
      },
      workspace,
      workspaceSeeds: { stage: () => Effect.succeed({ workspaceSeedId: "workspace-seed-startup" }) },
      executionForThread: () => {
        executionFactoryCalls += 1
        return Effect.die("A failed creation must not create execution")
      },
    })
    yield* Effect.yieldNow
    client.newThread("orb")
    yield* waitForDetachedUntil(() => creations === 1)
    expect(creations).toBe(1)
    expect(executionFactoryCalls).toBe(0)
    expect(client.state.threads).toEqual([])
    expect(client.state.selectedThreadId).toBe("")
    expect(client.state.notice).toContain("Thread creation was denied")
    yield* client.dispose
  }).pipe(Effect.provide(BunFileSystem.layer)),
)

it.effect("keeps an explicit missing Thread as a selection error", () =>
  Effect.gen(function* () {
    const calls = { create: 0, ensureSession: 0, executionFactory: 0 }
    const client = createThreadClient({
      product: {
        ...product(),
        thread: () =>
          ProductClientError.make({ kind: "protocol", message: "Requested Thread was not found", status: 404 }),
        createThread: () => {
          calls.create += 1
          return Effect.die("Selection must not create a Thread")
        },
        ensureSession: () => {
          calls.ensureSession += 1
          return Effect.die("Selection must not create a Session for an unknown Thread")
        },
      },
      executionForThread: () => {
        calls.executionFactory += 1
        return Effect.die("Selection must not create execution for an unknown Thread")
      },
      initialThreadId: "missing",
    })
    yield* Effect.yieldNow
    expect(calls).toEqual({ create: 0, ensureSession: 0, executionFactory: 0 })
    expect(client.state.selectedThreadId).toBe("missing")
    expect(client.state.threads.map((thread) => thread.id)).toEqual(["thread"])
    expect(client.state.notice).toContain("thread.read: Requested Thread was not found")
    yield* client.dispose
  }),
)

it.effect("creates a Runner replacement atomically and retries its stable archive source request", () =>
  Effect.gen(function* () {
    let attempts = 0
    const test = archiveFixture({
      create: (request) => {
        attempts += 1
        return attempts === 1
          ? ProductClientError.make({ kind: "network", message: "Archive replacement response was lost" })
          : Effect.succeed({ threadId: request.threadId })
      },
    })
    yield* settle()
    test.client.archiveAndNewThread()
    yield* settle()
    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]).toMatchObject({ target: "runner", archiveThreadId: "thread" })
    expect(test.archives).toEqual([])
    expect(test.threads.some((thread) => thread.id === "thread")).toBe(true)

    test.client.archiveAndNewThread()
    yield* settle()
    expect(test.requests).toHaveLength(2)
    expect(test.requests[1]).toEqual(test.requests[0])
    expect(test.archives).toEqual([])
    expect(test.threads.some((thread) => thread.id === "thread")).toBe(false)
    expect(test.threads.some((thread) => thread.id === test.requests[0]?.threadId)).toBe(true)
    yield* test.client.dispose
  }),
)

it.effect("does not archive when a replacement has no local Runner", () =>
  Effect.gen(function* () {
    const test = archiveFixture({ runner: false })
    yield* settle()
    test.client.archiveAndNewThread()
    yield* settle()
    expect(test.requests).toEqual([])
    expect(test.archives).toEqual([])
    expect(test.client.state.notice).toContain("No local Runner is registered")
    yield* test.client.dispose
  }),
)

it.effect("fences archive callbacks after selection changes and keeps archive failures open", () =>
  Effect.gen(function* () {
    let archived = 0
    const successful = archiveFixture()
    yield* settle()
    successful.client.archiveThread(() => {
      archived += 1
    })
    yield* settle()
    expect(successful.archives).toEqual(["thread"])
    expect(archived).toBe(1)
    yield* successful.client.dispose

    const replacementGate = yield* Deferred.make<void>()
    let replacementCreated = 0
    const replacement = archiveFixture({
      create: (request) => Deferred.await(replacementGate).pipe(Effect.as({ threadId: request.threadId })),
    })
    yield* settle()
    replacement.client.archiveAndNewThread(() => {
      replacementCreated += 1
    })
    yield* settle()
    replacement.client.selectThread("other")
    yield* settle()
    yield* Deferred.succeed(replacementGate, undefined)
    yield* settle()
    expect(replacement.requests[0]).toMatchObject({ archiveThreadId: "thread" })
    expect(replacement.archives).toEqual([])
    expect(replacement.client.state.selectedThreadId).toBe("other")
    expect(replacementCreated).toBe(0)
    yield* replacement.client.dispose

    const gate = yield* Deferred.make<void>()
    let quit = 0
    const test = archiveFixture({
      archive: (threadId) => Deferred.await(gate).pipe(Effect.as({ threadId, archived: true })),
    })
    yield* settle()
    test.client.archiveThread(() => {
      quit += 1
    })
    yield* settle()
    test.client.selectThread("other")
    yield* settle()
    yield* Deferred.succeed(gate, undefined)
    yield* settle()
    expect(test.archives).toEqual(["thread"])
    expect(test.client.state.selectedThreadId).toBe("other")
    expect(quit).toBe(0)
    yield* test.client.dispose

    let failedQuit = 0
    const failed = archiveFixture({
      archive: () => ProductClientError.make({ kind: "network", message: "Thread archive was rejected" }),
    })
    yield* settle()
    failed.client.archiveThread(() => {
      failedQuit += 1
    })
    yield* settle()
    expect(failed.client.state.selectedThreadId).toBe("thread")
    expect(failed.client.state.notice).toContain("Thread archive was rejected")
    expect(failedQuit).toBe(0)
    yield* failed.client.dispose
  }),
)
