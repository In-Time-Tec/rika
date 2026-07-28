import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "../src/product-database"
import * as UsageRepository from "../src/usage-repository"

const complete: UsageRepository.Materialized = {
  costNanoUsd: 1_250_000_000,
  tokens: 30,
  activeMillis: 450,
  activeIntervals: [{ start: 100, end: 550 }],
  pricedAttempts: 1,
  unpricedAttempts: 0,
  countedAttempts: 1,
  uncountedAttempts: 0,
  sourceComplete: true,
}

const exercise = (repository: UsageRepository.Interface) =>
  Effect.gen(function* () {
    expect(yield* repository.readThread("missing")).toEqual({
      turns: 0,
      pricedAttempts: 0,
      unpricedAttempts: 0,
      countedAttempts: 0,
      uncountedAttempts: 0,
      sourceComplete: false,
    })
    expect(yield* repository.admit("turn-a", "thread-a")).toMatchObject({
      revision: 0,
      sourceComplete: false,
    })
    expect(yield* repository.admit("turn-a", "different-thread")).toMatchObject({ threadId: "thread-a" })
    expect(yield* repository.commitFold("turn-a", 0, "fold-a", complete)).toMatchObject({
      _tag: "Applied",
      value: { revision: 1, foldJson: "fold-a", ...complete },
    })
    expect(yield* repository.commitFold("turn-a", 0, "stale", complete)).toEqual({ _tag: "Conflict" })
    yield* repository.admit("turn-b", "thread-a")
    expect(yield* repository.readThread("thread-a")).toMatchObject({
      turns: 2,
      pricedAttempts: 1,
      sourceComplete: false,
    })
    expect((yield* repository.readThread("thread-a")).costNanoUsd).toBeUndefined()
    expect(
      yield* repository.commitFold("turn-b", 0, "fold-b", { ...complete, costNanoUsd: 750_000_000 }),
    ).toMatchObject({
      _tag: "Applied",
    })
    expect(yield* repository.readGlobal).toMatchObject({
      turns: 2,
      costNanoUsd: 2_000_000_000,
      tokens: 60,
      activeMillis: 450,
      sourceComplete: true,
    })
    expect(yield* repository.claimRepair("turn-a", "owner-a")).toEqual({ _tag: "Claimed" })
    expect(yield* repository.claimRepair("turn-a", "owner-b")).toEqual({ _tag: "Busy" })
    expect(yield* repository.checkpointRepair("turn-a", "owner-b", "bad")).toBe(false)
    expect(yield* repository.checkpointRepair("turn-a", "owner-a", "cursor-1")).toBe(true)
    expect(yield* repository.claimRepair("turn-a", "owner-a")).toEqual({
      _tag: "Claimed",
      checkpoint: "cursor-1",
    })
    expect(yield* repository.finishRepair("turn-a", "owner-b")).toBe(false)
    expect(yield* repository.finishRepair("turn-a", "owner-a")).toBe(true)
  })

it.layer(UsageRepository.memoryLayer)("memory usage repository", (test) => {
  test.effect("preserves persisted usage, aggregate partials, CAS, and repair ownership", () =>
    Effect.gen(function* () {
      yield* exercise(yield* UsageRepository.Service)
    }),
  )

  test.effect("rejects unsafe materialized integers", () =>
    Effect.gen(function* () {
      const repository = yield* UsageRepository.Service
      yield* repository.admit("turn", "thread")
      const exit = yield* Effect.exit(
        repository.commitFold("turn", 0, "fold", { ...complete, tokens: Number.MAX_SAFE_INTEGER + 1 }),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )

  test.effect("owns committed active intervals", () =>
    Effect.gen(function* () {
      const repository = yield* UsageRepository.Service
      const intervals: Array<UsageRepository.ActiveInterval> = [{ start: 100, end: 550 }]
      yield* repository.admit("turn", "thread")
      yield* repository.commitFold("turn", 0, "fold", { ...complete, activeIntervals: intervals })
      intervals[0] = { start: 0 }
      expect((yield* repository.readTurn("turn"))?.activeIntervals).toEqual([{ start: 100, end: 550 }])
    }),
  )

  test.effect("fences a repair owner after its lease is taken over", () =>
    Effect.gen(function* () {
      const repository = yield* UsageRepository.Service
      yield* repository.admit("turn", "thread")
      expect(yield* repository.claimRepair("turn", "owner-a")).toEqual({ _tag: "Claimed" })
      yield* TestClock.adjust("6 minutes")
      expect(yield* repository.checkpointRepair("turn", "owner-a", "expired")).toBe(false)
      expect(yield* repository.commitRepairFold("turn", "owner-a", 0, "expired", complete)).toEqual({
        _tag: "Conflict",
      })
      expect(yield* repository.claimRepair("turn", "owner-b")).toEqual({ _tag: "Claimed" })
      expect(yield* repository.commitRepairFold("turn", "owner-a", 0, "stale", complete)).toEqual({
        _tag: "Conflict",
      })
    }),
  )
})

it.layer(BunServices.layer)("SQLite usage repository", (test) => {
  test.effect("matches memory semantics, survives reopen, and cascades with its Turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-usage-repository-" })
        const filename = `${directory}/rika.db`
        const database = yield* Layer.build(Database.layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`INSERT INTO rika_workspaces (path, created_at) VALUES ('/work', 1)`
          yield* sql`INSERT INTO rika_threads (id, workspace, title, created_at, updated_at) VALUES
            ('thread-a', '/work', 'A', 1, 1)`
          yield* sql`INSERT INTO rika_turns
            (id, thread_id, prompt, status, created_at, updated_at, execution_route_json)
            VALUES ('turn-a', 'thread-a', 'A', 'completed', 1, 1, '{}'),
                   ('turn-b', 'thread-a', 'B', 'completed', 2, 2, '{}')`
          const usageContext = yield* Layer.build(UsageRepository.layer).pipe(Effect.provide(database))
          yield* exercise(Context.get(usageContext, UsageRepository.Service))
          yield* sql`DELETE FROM rika_turns WHERE id = 'turn-a'`
          expect(yield* sql`SELECT turn_id FROM rika_turn_usage WHERE turn_id = 'turn-a'`).toEqual([])
          expect(yield* sql`SELECT turn_id FROM rika_usage_repairs WHERE turn_id = 'turn-a'`).toEqual([])
          yield* sql`UPDATE rika_turn_usage SET projection_version = 2 WHERE turn_id = 'turn-b'`
          expect((yield* Effect.exit(Context.get(usageContext, UsageRepository.Service).readGlobal))._tag).toBe(
            "Failure",
          )
          expect(yield* sql`SELECT projection_version FROM rika_turn_usage WHERE turn_id = 'turn-b'`).toEqual([
            { projection_version: 2 },
          ])
          yield* sql`UPDATE rika_turn_usage SET projection_version = 1 WHERE turn_id = 'turn-b'`
        }).pipe(Effect.provide(database))

        const reopened = yield* Layer.build(Database.layer(filename))
        const usageContext = yield* Layer.build(UsageRepository.layer).pipe(Effect.provide(reopened))
        const repository = Context.get(usageContext, UsageRepository.Service)
        expect(yield* repository.readTurn("turn-b")).toMatchObject({ revision: 1, foldJson: "fold-b" })
      }),
    ),
  )
})
