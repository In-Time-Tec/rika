/* oxlint-disable anti-slop/no-chained-type-assertions -- focused protocol fixtures implement only the exercised client surface. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- focused protocol fixtures are checked through the production consumer. */
/* oxlint-disable effecttsgo/strict-effect-provide -- this test supplies deterministic platform services at its boundary. */
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { ProductClientError, type ProductClient } from "@rika/client/product"
import type { WorkspaceSeedClient } from "@rika/client/workspace-seeds"
import { EncodedArchive } from "@rika/workspace-input/contract"
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import {
  createOrbThreadWithClients,
  creationOptions,
  mostRecentThread,
  runHeadless,
  runRemoteWithClients,
  type OnlineOrbClients,
  type OnlineClients,
  type RemoteExecutionClient,
} from "../../src/client/online"
import { ProfileStore } from "../../src/hosted/contract"

const profile = {
  origin: "https://rika.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "organization" as const, organizationId: "organization-1" },
  project: "project-1",
}

const encodedArchive = Schema.decodeSync(EncodedArchive)({
  content: "H4sIAAAAAAACAwMAAAAAAAAAAAA=",
  contentDigest: `sha256:${"0".repeat(64)}`,
  sizeBytes: 1,
})

const runStarted = (runId: string, correlationId: string, cursor: number) => ({
  _tag: "RunStarted" as const,
  sessionId: "session-1",
  cursor,
  runId,
  event: {
    _tag: "RunAccepted" as const,
    specVersion: "1" as const,
    eventId: `event-${runId}`,
    runId,
    rootRunId: runId,
    sequence: 0,
    executableRef: { executable: "agent", active: "agent" },
    depth: 0,
    occurredAt: "2026-09-10T00:00:00.000Z",
    messageId: `message-${runId}`,
    address: "runtime:session-input",
    correlationId,
  },
})

interface FocusedExecutionFixture {
  readonly snapshot?: unknown
  readonly submit?: unknown
  readonly subscribe?: unknown
  readonly removeInput?: unknown
  readonly cancel?: unknown
}

// SAFETY: each focused fixture implements every released client method exercised by runRemoteWithClients.
const executionFixture = (fixture: FocusedExecutionFixture) => fixture as unknown as RemoteExecutionClient

it("maps the selected owner and project into V2 Thread creation", () => {
  expect(creationOptions(profile)).toEqual({
    owner: { kind: "organization", organization_id: "organization-1" },
    projectId: "project-1",
  })
  expect(creationOptions({ ...profile, owner: { kind: "personal" }, project: undefined })).toEqual({
    owner: { kind: "personal" },
  })
})

it.effect("scopes --last to the selected owner and project", () =>
  Effect.gen(function* () {
    const requests: Array<Parameters<ProductClient["listThreads"]>[0]> = []
    const product = {
      listThreads: (input?: Parameters<ProductClient["listThreads"]>[0]) =>
        Effect.sync(() => {
          requests.push(input)
          return {
            threads: [{ id: "thread-scoped", title: "Scoped Thread", target: "runner" as const }],
            nextCursor: null,
          }
        }),
    } satisfies Pick<ProductClient, "listThreads">

    expect(yield* mostRecentThread(profile, product)).toBe("thread-scoped")
    expect(requests).toEqual([
      {
        limit: 1,
        scope: { owner: { kind: "organization", organization_id: "organization-1" }, projectId: "project-1" },
      },
    ])

    expect(yield* mostRecentThread({ ...profile, owner: { kind: "personal" }, project: undefined }, product)).toBe(
      "thread-scoped",
    )
    expect(requests[1]).toEqual({ limit: 1, scope: { owner: { kind: "personal" } } })
  }),
)

it.effect("stages the captured Workspace and creates an Orb with that exact seed", () =>
  Effect.gen(function* () {
    const staged: Array<Parameters<WorkspaceSeedClient["stage"]>[0]> = []
    const created: Array<Parameters<ProductClient["createThread"]>[0]> = []
    const clients = {
      profile,
      workspaceSeeds: {
        stage: (input) =>
          Effect.sync(() => {
            staged.push(input)
            return { workspaceSeedId: "seed-1" }
          }),
      },
      product: {
        createThread: (input: Parameters<ProductClient["createThread"]>[0]) =>
          Effect.sync(() => {
            created.push(input)
            return { threadId: input.threadId }
          }),
      },
    } satisfies OnlineOrbClients

    yield* createOrbThreadWithClients(clients, encodedArchive)
    expect(staged).toEqual([
      {
        owner: { kind: "organization", organization_id: "organization-1" },
        projectId: "project-1",
        archive: encodedArchive,
      },
    ])
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      owner: { kind: "organization", organization_id: "organization-1" },
      projectId: "project-1",
      target: "orb",
      workspaceSeedId: "seed-1",
    })
    expect(created[0]?.threadId).toMatch(/^rika:thread:/)
    expect(yield* TestConsole.logLines).toEqual([`Created Orb Thread ${created[0]?.threadId}`])
  }).pipe(Effect.provide(Layer.merge(BunCrypto.layer, TestConsole.layer))),
)

it.effect("does not create an Orb when Workspace staging fails", () =>
  Effect.gen(function* () {
    let createCalls = 0
    const clients = {
      profile,
      workspaceSeeds: {
        stage: () =>
          Effect.fail(ProductClientError.make({ kind: "network", message: "Workspace staging is unavailable" })),
      },
      product: {
        createThread: (input: Parameters<ProductClient["createThread"]>[0]) =>
          Effect.sync(() => {
            createCalls++
            return { threadId: input.threadId }
          }),
      },
    } satisfies OnlineOrbClients

    const error = yield* Effect.flip(createOrbThreadWithClients(clients, encodedArchive))
    expect(error.message).toBe("Workspace staging is unavailable")
    expect(createCalls).toBe(0)
  }).pipe(Effect.provide(BunCrypto.layer)),
)

it.effect("fails headless Runner startup when no hosted profile is selected", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(runHeadless({ workspace: "/workspace", remoteThreadCreation: "allowed" }))
    expect(error.message).toBe("Run rika auth login first")
  }).pipe(
    Effect.provideService(
      ProfileStore,
      ProfileStore.of({ load: Effect.succeed(Option.none()), save: () => Effect.void }),
    ),
    Effect.provide(BunServices.layer),
  ),
)

it.effect("correlates a queued Generalist input to its own Run and prints that final answer", () => {
  const completed = {
    _tag: "Completed" as const,
    sessionId: "session-1",
    cursor: 10,
    runId: "run-matching",
    event: {
      _tag: "RunCompleted" as const,
      specVersion: "1" as const,
      eventId: "event-completed",
      runId: "run-matching",
      rootRunId: "run-matching",
      sequence: 1,
      executableRef: { executable: "agent", active: "agent" },
      depth: 0,
      occurredAt: "2026-09-10T00:00:01.000Z",
      result: {
        text: "final answer",
        output: null,
        turns: 1,
        session: { sessionId: "session-1", leafId: "run-matching" },
      },
    },
  }
  let inputId = ""
  const execution = executionFixture({
    snapshot: () =>
      Effect.succeed({
        version: 1,
        cursor: 7,
        session: { id: "session-1", createdAt: "2026-09-10T00:00:00.000Z", queue: [] },
        runs: [],
        conversation: { leafId: null, entries: [] },
      }),
    submit: (input: { readonly commandId: string }) =>
      Effect.sync(() => {
        inputId = input.commandId
        return { id: input.commandId, revision: 1 }
      }),
    subscribe: () => {
      const events = [runStarted("run-unrelated", "other-input", 8), runStarted("run-matching", inputId, 9), completed]
      // SAFETY: this fixture supplies every field read by the released client's HostEvent consumers.
      return Stream.fromIterable(events) as unknown as ReturnType<RemoteExecutionClient["subscribe"]>
    },
  })
  const clients = {
    product: {
      thread: () => Effect.succeed({ id: "thread-1", title: "Thread", target: "runner" as const }),
      ensureSession: () => Effect.succeed({ sessionId: "session-1", created: false }),
    },
    execution: () => Effect.succeed(execution),
  } satisfies OnlineClients

  return runRemoteWithClients(
    { _tag: "RemoteRun", threadId: "thread-1", request: { prompt: ["do the work"] } },
    clients,
  ).pipe(
    Effect.provide(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer, TestConsole.layer)),
    Effect.tap(() =>
      TestConsole.logLines.pipe(Effect.tap((lines) => Effect.sync(() => expect(lines).toEqual(["final answer"])))),
    ),
  )
})

it.effect("removes its queued Generalist input when the command is interrupted before admission", () =>
  Effect.gen(function* () {
    const submitted = yield* Deferred.make<void>()
    const removed = yield* Deferred.make<{ readonly id: string; readonly expectedRevision: number }>()
    let snapshots = 0
    let inputId = ""
    const execution = executionFixture({
      snapshot: () =>
        Effect.sync(() => {
          snapshots++
          return {
            version: 1 as const,
            cursor: 7,
            session: {
              id: "session-1",
              createdAt: "2026-09-10T00:00:00.000Z",
              queue: snapshots === 1 ? [] : [{ id: inputId, revision: 4 }],
            },
            runs: [],
            conversation: { leafId: null, entries: [] },
          }
        }),
      submit: (input: { readonly commandId: string }) =>
        Effect.sync(() => {
          inputId = input.commandId
        }).pipe(
          Effect.andThen(Deferred.succeed(submitted, undefined)),
          Effect.as({ id: input.commandId, revision: 1 }),
        ),
      subscribe: () => Stream.never,
      removeInput: (input: { readonly id: string; readonly expectedRevision: number }) =>
        Deferred.succeed(removed, input).pipe(Effect.as({ id: input.id, revision: input.expectedRevision + 1 })),
    })
    const clients = {
      product: {
        thread: () => Effect.succeed({ id: "thread-1", title: "Thread", target: "runner" as const }),
        ensureSession: () => Effect.succeed({ sessionId: "session-1", created: false }),
      },
      execution: () => Effect.succeed(execution),
    } satisfies OnlineClients
    const fiber = yield* runRemoteWithClients(
      { _tag: "RemoteRun", threadId: "thread-1", request: { prompt: ["do the work"] } },
      clients,
    ).pipe(Effect.forkChild)

    yield* Deferred.await(submitted)
    yield* Fiber.interrupt(fiber)
    expect(yield* Deferred.await(removed)).toMatchObject({ id: inputId, expectedRevision: 4 })
  }).pipe(Effect.provide(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer, TestConsole.layer))),
)

it.effect("cancels its admitted Generalist Run when the command is interrupted", () =>
  Effect.gen(function* () {
    const watchingCompletion = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<{ readonly runId: string; readonly reason: string }>()
    let inputId = ""
    let subscriptions = 0
    const execution = executionFixture({
      snapshot: () =>
        Effect.succeed({
          version: 1 as const,
          cursor: 7,
          session: { id: "session-1", createdAt: "2026-09-10T00:00:00.000Z", queue: [] },
          runs: [],
          conversation: { leafId: null, entries: [] },
        }),
      submit: (input: { readonly commandId: string }) =>
        Effect.sync(() => {
          inputId = input.commandId
          return { id: input.commandId, revision: 1 }
        }),
      subscribe: () => {
        subscriptions++
        if (subscriptions === 1) return Stream.make(runStarted("run-matching", inputId, 8))
        return Stream.unwrap(Deferred.succeed(watchingCompletion, undefined).pipe(Effect.as(Stream.never)))
      },
      cancel: (input: { readonly runId: string; readonly reason: string }) =>
        Deferred.succeed(cancelled, input).pipe(Effect.as({ runId: input.runId, duplicate: false })),
    })
    const clients = {
      product: {
        thread: () => Effect.succeed({ id: "thread-1", title: "Thread", target: "runner" as const }),
        ensureSession: () => Effect.succeed({ sessionId: "session-1", created: false }),
      },
      execution: () => Effect.succeed(execution),
    } satisfies OnlineClients
    const fiber = yield* runRemoteWithClients(
      { _tag: "RemoteRun", threadId: "thread-1", request: { prompt: ["do the work"] } },
      clients,
    ).pipe(Effect.forkChild)

    yield* Deferred.await(watchingCompletion)
    yield* Fiber.interrupt(fiber)
    expect(yield* Deferred.await(cancelled)).toMatchObject({
      runId: "run-matching",
      reason: "Rika client interrupted",
    })
  }).pipe(Effect.provide(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer, TestConsole.layer))),
)

it.effect("finds and cancels its Run when interruption makes the submit response ambiguous", () =>
  Effect.gen(function* () {
    const submitted = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<{ readonly runId: string; readonly reason: string }>()
    let inputId = ""
    const execution = executionFixture({
      snapshot: () =>
        Effect.succeed({
          version: 1 as const,
          cursor: 7,
          session: { id: "session-1", createdAt: "2026-09-10T00:00:00.000Z", queue: [] },
          runs: [],
          conversation: { leafId: null, entries: [] },
        }),
      submit: (input: { readonly commandId: string }) =>
        Effect.sync(() => {
          inputId = input.commandId
        }).pipe(Effect.andThen(Deferred.succeed(submitted, undefined)), Effect.andThen(Effect.never)),
      subscribe: () => Stream.make(runStarted("run-ambiguous", inputId, 8)),
      cancel: (input: { readonly runId: string; readonly reason: string }) =>
        Deferred.succeed(cancelled, input).pipe(Effect.as({ runId: input.runId, duplicate: false })),
    })
    const clients = {
      product: {
        thread: () => Effect.succeed({ id: "thread-1", title: "Thread", target: "runner" as const }),
        ensureSession: () => Effect.succeed({ sessionId: "session-1", created: false }),
      },
      execution: () => Effect.succeed(execution),
    } satisfies OnlineClients
    const fiber = yield* runRemoteWithClients(
      { _tag: "RemoteRun", threadId: "thread-1", request: { prompt: ["do the work"] } },
      clients,
    ).pipe(Effect.forkChild)

    yield* Deferred.await(submitted)
    yield* Fiber.interrupt(fiber)
    expect(yield* Deferred.await(cancelled)).toMatchObject({
      runId: "run-ambiguous",
      reason: "Rika client interrupted",
    })
  }).pipe(Effect.provide(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer, TestConsole.layer))),
)
