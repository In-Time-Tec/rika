import * as ExecutionProjection from "@rika/product/execution-projection"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as UnitOrder from "@rika/transcript/transcript-unit-order"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as Database from "../src/database/product-database-layer"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import * as ThreadResult from "@rika/product/thread-result"

const testTurn = (id: string, threadId = "thread-direct-memory") => ({
  _tag: "AgentExecution" as const,
  id: Turn.TurnId.make(id),
  threadId: Thread.ThreadId.make(threadId),
  prompt: "approve",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  status: "completed" as const,
  author: { _tag: "Human" as const },
  lineage: { _tag: "Original" as const },
  createdAt: 1,
  updatedAt: 1,
})
const sqliteLayer = (filename: string) => {
  const database = Database.layer(filename)
  return Layer.mergeAll(
    database,
    ThreadRepository.layer.pipe(Layer.provide(database)),
    TurnRepository.layer.pipe(Layer.provide(database)),
    TranscriptRepository.layer.pipe(Layer.provide(database)),
  )
}
const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })
const createTurn = Effect.fn("DirectProjectionTest.createTurn")(function* (
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
) {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  yield* threads.create({ id: threadId, workspace: "/workspace", title: "direct", now: 1 })
  yield* turns.createForSubmission({
    id: turnId,
    threadId,
    prompt: "approve",
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    queueCapacity: 8,
    now: 2,
  })
  return yield* turns.setStatus(turnId, "completed", 3)
})

const state = {
  status: "waiting" as const,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
}
const checkpoint = (cursor: string, marker: string) => ({
  version: ExecutionProjection.projectionVersion,
  cursor,
  state: JSON.stringify({ marker }),
})
const snapshot = (turnId: Turn.TurnId) => ({
  _tag: "ProjectionSnapshot" as const,
  revision: 0,
  checkpoint: checkpoint("cursor-waiting", "waiting"),
  units: [
    {
      key: "assistant",
      turnId,
      order: UnitOrder.unitOrder("assistant", 0, 0),
      revision: 0,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: "partial" },
    },
  ],
  hasOlder: false,
  state,
})
const approvedPatch = (turnId: Turn.TurnId) => ({
  _tag: "ProjectionPatch" as const,
  baseRevision: 0,
  revision: 1,
  checkpoint: checkpoint("cursor-approved", "approved"),
  upsert: [
    {
      key: "assistant",
      turnId,
      order: UnitOrder.unitOrder("assistant", 0, 0),
      revision: 1,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: "partial after approval" },
    },
  ],
  remove: [],
  state: { ...state, status: "running" as const },
})

const continuationPatch = (turnId: Turn.TurnId) => ({
  _tag: "ProjectionPatch" as const,
  baseRevision: 1,
  revision: 2,
  checkpoint: checkpoint("cursor-complete", "complete"),
  upsert: [
    {
      key: "assistant-final",
      turnId,
      order: UnitOrder.unitOrder("assistant-final", 1, 0),
      revision: 2,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: "done" },
    },
  ],
  remove: [],
  state: { ...state, status: "completed" as const },
})

it.effect("atomically resumes the opaque root projector checkpoint in memory", () =>
  Effect.gen(function* () {
    const target = testTurn("turn-950")
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    expect(yield* repository.commitProjection(target, snapshot(target.id))).toBe("committed")
    const waiting = yield* repository.get(target.id)
    expect(waiting?.projectorCheckpoint).toEqual(checkpoint("cursor-waiting", "waiting"))

    const restarted = yield* TranscriptRepository.makeMemory({ initial: waiting === undefined ? [] : [waiting], turns })
    expect(yield* restarted.commitProjection(target, approvedPatch(target.id))).toBe("committed")
    expect(yield* restarted.commitProjection(target, approvedPatch(target.id))).toBe("stale")
    expect(yield* restarted.commitProjection(target, continuationPatch(target.id))).toBe("committed")
    const newest = yield* restarted.page(target.threadId, { limit: 1 })
    expect(newest).toMatchObject({ hasOlder: true, entries: [{ unit: { key: "assistant-final" } }] })
    expect((yield* restarted.page(target.threadId, { limit: 1, before: newest.oldestCursor! })).entries).toMatchObject([
      { unit: { key: "assistant" } },
    ])
    expect(yield* restarted.get(target.id)).toMatchObject({
      revision: 2,
      projectorCheckpoint: checkpoint("cursor-complete", "complete"),
      units: expect.arrayContaining([
        expect.objectContaining({ content: expect.objectContaining({ text: "partial after approval" }) }),
      ]),
    })
  }),
)

it.effect("atomically resumes the opaque root projector checkpoint in SQLite", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-direct-projection-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-direct-projection"),
            Turn.TurnId.make("turn-direct-projection"),
          )
          expect(yield* repository.commitProjection(target, snapshot(target.id))).toBe("committed")
          expect((yield* repository.get(target.id))?.projectorCheckpoint).toEqual(
            checkpoint("cursor-waiting", "waiting"),
          )
          expect(yield* repository.commitProjection(target, approvedPatch(target.id))).toBe("committed")
          expect(yield* repository.commitProjection(target, approvedPatch(target.id))).toBe("stale")
          expect(yield* repository.commitProjection(target, continuationPatch(target.id))).toBe("committed")
          const newest = yield* repository.page(target.threadId, { limit: 1 })
          expect(newest).toMatchObject({ hasOlder: true, entries: [{ unit: { key: "assistant-final" } }] })
          expect(
            (yield* repository.page(target.threadId, { limit: 1, before: newest.oldestCursor! })).entries,
          ).toMatchObject([{ unit: { key: "assistant" } }])
          expect(yield* repository.get(target.id)).toMatchObject({
            revision: 2,
            projectionVersion: ExecutionProjection.projectionVersion,
            projectorCheckpoint: checkpoint("cursor-complete", "complete"),
            units: expect.arrayContaining([
              expect.objectContaining({ content: expect.objectContaining({ text: "partial after approval" }) }),
            ]),
          })
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

const runningShell = (id: string, threadId: string): ThreadResult.RunningRecordedShellTurn => ({
  _tag: "RecordedShell",
  id: Turn.TurnId.make(id),
  threadId: Thread.ThreadId.make(threadId),
  prompt: "$ printf done",
  command: "printf done",
  status: "running",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 10,
  updatedAt: 10,
})
const terminalShell = (turn: ThreadResult.RunningRecordedShellTurn): ThreadResult.TerminalRecordedShellTurn => ({
  ...turn,
  status: "completed",
  result: { text: "done", truncated: false, exitCode: 0 },
  updatedAt: 11,
})
const shellUnits = (turn: Turn.RecordedShellTurn) =>
  ThreadResult.TurnResult.isRunningRecordedShell(turn)
    ? recordedShellProjection(turn).units
    : settleRecordedShellProjection(
        recordedShellProjection({ id: turn.id, command: turn.command, status: "running" }),
        turn,
      ).units

it.effect("rebuilds recorded shell units from the authoritative memory turn after restart", () =>
  Effect.gen(function* () {
    const running = runningShell("shell-memory", "thread-shell-memory")
    const turns = yield* TurnRepository.makeMemory()
    const transcripts = yield* TranscriptRepository.makeMemory({ turns })
    yield* turns.createRecordedShell(running)
    const runningProjection = yield* transcripts.replaceUnits(running, shellUnits(running))
    expect(runningProjection.units[0]?.content).toMatchObject({ block: { status: "running" } })

    const terminal = terminalShell(running)
    expect(yield* turns.settleRecordedShell(running, terminal)).toEqual(terminal)
    const restarted = yield* TranscriptRepository.makeMemory({ turns, initial: [runningProjection] })
    const rebuilt = yield* restarted.replaceUnits(terminal, shellUnits(terminal))
    expect(rebuilt.projectorCheckpoint).toBeUndefined()
    expect(rebuilt.units[0]?.content).toMatchObject({
      block: { status: "complete", output: "done", process: { exitCode: 0, truncated: false } },
    })
  }),
)

it.effect("persists recorded shell start and settlement across SQLite restarts without a projector checkpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-shell-projection-" })
      const filename = `${directory}/rika.db`
      const running = runningShell("shell-sqlite", "thread-shell-sqlite")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id: running.threadId, workspace: "/workspace", title: "shell", now: 1 })
          yield* turns.createRecordedShell(running)
          yield* transcripts.replaceUnits(running, shellUnits(running))
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const restored = yield* turns.get(running.id)
          if (restored === undefined || !ThreadResult.TurnResult.isRunningRecordedShell(restored))
            return yield* Effect.die("shell did not restart")
          const terminal = terminalShell(restored)
          expect(yield* turns.settleRecordedShell(restored, terminal)).toEqual(terminal)
          yield* transcripts.replaceUnits(terminal, shellUnits(terminal))
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* (yield* TranscriptRepository.Service).get(running.id)
          expect(projection?.projectorCheckpoint).toBeUndefined()
          expect(projection?.state.status).toBe("completed")
          expect(projection?.units[0]?.content).toMatchObject({ block: { status: "complete", output: "done" } })
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("aggregates semantic projection usage from decoded SQLite transcript state across restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-usage-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-usage-state")
      const firstId = Turn.TurnId.make("turn-usage-first")
      const secondId = Turn.TurnId.make("turn-usage-second")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id: threadId, workspace: "/workspace", title: "usage", now: 1 })
          const admittedFirst = yield* turns.createForSubmission({
            id: firstId,
            threadId,
            prompt: "first",
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            queueCapacity: 8,
            now: 2,
          })
          const first = yield* turns.setStatus(admittedFirst.id, "completed", 3)
          yield* transcripts.commitProjection(first as Turn.AgentExecutionTurn, {
            ...snapshot(first.id),
            state: {
              status: "completed",
              usage: {
                costNanoUsd: 250_000_000,
                tokens: {
                  total: 15,
                  input: { total: 10, uncached: 7, cacheRead: 2, cacheWrite: 1 },
                  output: { total: 5, text: 4, reasoning: 1 },
                },
                pricedAttempts: 1,
                unpricedAttempts: 0,
                countedAttempts: 1,
                uncountedAttempts: 0,
                sourceComplete: true,
                context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 10 },
                contextPending: false,
                active: { _tag: "Available", accumulatedMillis: 40 },
              },
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          })
          const admittedSecond = yield* turns.createForSubmission({
            id: secondId,
            threadId,
            prompt: "second",
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            queueCapacity: 8,
            now: 4,
          })
          const second = yield* turns.setStatus(admittedSecond.id, "completed", 5)
          yield* transcripts.commitProjection(second as Turn.AgentExecutionTurn, {
            ...snapshot(second.id),
            state: {
              status: "completed",
              usage: {
                tokens: {
                  total: 9,
                  input: { total: 6 },
                  output: { total: 3 },
                  failedProviderTotal: 9,
                },
                pricedAttempts: 0,
                unpricedAttempts: 1,
                countedAttempts: 1,
                uncountedAttempts: 0,
                sourceComplete: true,
                context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 6 },
                contextPending: false,
                active: { _tag: "Available", accumulatedMillis: 20 },
              },
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          })
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          const summary = yield* transcripts.usage(threadId)
          expect(summary).toEqual({
            usage: {
              costNanoUsd: 250_000_000,
              tokens: {
                total: 24,
                input: { total: 16, uncached: 7, cacheRead: 2, cacheWrite: 1 },
                output: { total: 8, text: 4, reasoning: 1 },
                failedProviderTotal: 9,
              },
              pricedAttempts: 1,
              unpricedAttempts: 1,
              countedAttempts: 2,
              uncountedAttempts: 0,
              sourceComplete: true,
              context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 6 },
              contextPending: false,
              active: { _tag: "Available", accumulatedMillis: 60 },
            },
            contextCapacity: { contextWindow: 372_000, reserveTokens: 128_000 },
          })
          const page = yield* transcripts.page(threadId, { limit: 10 })
          expect(page.usage).toEqual(summary)
          expect(page.entries.every((entry) => entry.projectionState.usage.sourceComplete)).toBe(true)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
