import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "../src/product-database"
import * as Usage from "../src/usage-repository"

const complete: Usage.Materialized = {
  costNanoUsd: 100,
  tokens: 10,
  activeIntervals: [{ start: 100, end: 300 }],
  pricedAttempts: 1,
  unpricedAttempts: 0,
  countedAttempts: 1,
  uncountedAttempts: 0,
  sourceComplete: true,
}

const exercise = (repository: Usage.Interface) =>
  Effect.gen(function* () {
    yield* repository.admitSource("root", "turn-a", "thread")
    yield* repository.admitSource("title", "turn-a", "thread")
    yield* repository.admitSource("root", "turn-b", "thread")
    expect(yield* repository.commitSource("root", "turn-a", 0, "root-fold", complete)).toMatchObject({
      _tag: "Applied",
      value: { sourceId: "root", revision: 1 },
    })
    expect(
      yield* repository.commitSource("title", "turn-a", 0, "title-fold", {
        ...complete,
        costNanoUsd: 50,
        tokens: 5,
        activeIntervals: [{ start: 200, end: 400 }],
      }),
    ).toMatchObject({ _tag: "Applied" })
    expect(yield* repository.commitSource("root", "turn-a", 0, "stale", complete)).toMatchObject({
      _tag: "Conflict",
      value: { foldJson: "root-fold" },
    })
    expect(yield* repository.readSource("title", "turn-a")).toMatchObject({ foldJson: "title-fold" })
    expect(yield* repository.readTurn("turn-a")).toEqual({
      turnId: "turn-a",
      threadId: "thread",
      revision: 2,
      projectionVersion: Usage.projectionVersion,
      costNanoUsd: 150,
      tokens: 15,
      activeMillis: 300,
      activeIntervals: [{ start: 100, end: 400 }],
      pricedAttempts: 2,
      unpricedAttempts: 0,
      countedAttempts: 2,
      uncountedAttempts: 0,
      sourceComplete: true,
    })
    expect(yield* repository.readThread("thread")).toMatchObject({
      turns: 2,
      revision: 2,
      projectionVersion: Usage.projectionVersion,
      activeMillis: 300,
      sourceComplete: false,
    })
    expect(yield* repository.readTurn("turn-a")).not.toHaveProperty("foldJson")
    expect(yield* repository.replaceSource("missing", "turn-b", "thread", 1, 0, "new", complete)).toMatchObject({
      _tag: "Applied",
      value: { revision: 1 },
    })
    expect(
      yield* repository.replaceSource("missing", "turn-b", "thread", 1, 0, "regress", { ...complete, tokens: 999 }),
    ).toMatchObject({ _tag: "Conflict", value: { foldJson: "new", tokens: 10 } })
    expect(yield* repository.replaceSource("missing", "turn-b", "other-thread", 2, 1, "move", complete)).toMatchObject({
      _tag: "Conflict",
      value: { threadId: "thread", foldJson: "new" },
    })
    expect(yield* Effect.flip(repository.admitSource("root", "turn-a", "other-thread"))).toBeInstanceOf(
      Usage.RepositoryError,
    )
    expect(yield* repository.readSource("missing", "turn-b")).toMatchObject({ threadId: "thread", foldJson: "new" })
  })

it.layer(Usage.memoryLayer)("memory usage repository", (test) => {
  test.effect("normalizes sources and preserves aggregate and replacement semantics", () =>
    Effect.gen(function* () {
      yield* exercise(yield* Usage.Service)
    }),
  )
})

it.layer(BunServices.layer)("SQLite usage repository", (test) => {
  test.effect("matches memory semantics, cascades, and survives reopen", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rika-usage-" })
        const filename = `${directory}/rika.db`
        const database = yield* Layer.build(Database.layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`INSERT INTO rika_workspaces (path, created_at) VALUES ('/work', 1)`
          yield* sql`INSERT INTO rika_threads (id, workspace, title, created_at, updated_at) VALUES ('thread', '/work', 'A', 1, 1)`
          yield* sql`INSERT INTO rika_threads (id, workspace, title, created_at, updated_at) VALUES ('other-thread', '/work', 'B', 1, 1)`
          yield* sql`INSERT INTO rika_turns (id, thread_id, prompt, status, created_at, updated_at, execution_route_json) VALUES
        ('turn-a', 'thread', 'A', 'completed', 1, 1, '{}'), ('turn-b', 'thread', 'B', 'completed', 2, 2, '{}')`
          const usage = Context.get(yield* Layer.build(Usage.layer).pipe(Effect.provide(database)), Usage.Service)
          yield* exercise(usage)
          yield* sql`UPDATE rika_turn_usage SET thread_id = 'other-thread' WHERE turn_id = 'turn-a' AND source_id = 'title'`
          expect(yield* Effect.exit(usage.readTurn("turn-a"))).toMatchObject({ _tag: "Failure" })
          expect(yield* Effect.exit(usage.readThread("thread"))).toMatchObject({ _tag: "Failure" })
          expect(yield* Effect.exit(usage.readGlobal)).toMatchObject({ _tag: "Failure" })
          yield* sql`DELETE FROM rika_turns WHERE id = 'turn-a'`
          expect(yield* sql`SELECT source_id FROM rika_turn_usage WHERE turn_id = 'turn-a'`).toEqual([])
        }).pipe(Effect.provide(database))
        const reopened = yield* Layer.build(Database.layer(filename))
        const usage = Context.get(yield* Layer.build(Usage.layer).pipe(Effect.provide(reopened)), Usage.Service)
        expect(yield* usage.readSource("missing", "turn-b")).toMatchObject({ foldJson: "new", revision: 1 })
      }),
    ),
  )
})
