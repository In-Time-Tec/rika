import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { Database, Thread, ThreadRepository } from "../src"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"

const id = Thread.ThreadId.make("thread-a")

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

test("migrates, persists, and reopens", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persistence-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.merge(
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        yield* repository.create({
          id,
          workspace: "/work/a",
          title: "First",
          now: 1,
        })
        yield* repository.label(id, ["local"], 2)
        const turns = yield* TurnRepository.Service
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("turn-a"),
          threadId: id,
          prompt: "hello",
          now: 3,
        })
        yield* turns.setExtensionPin(Turn.TurnId.make("turn-a"), {
          generation: "generation-a",
          sourceDigest: "source-a",
          configFingerprint: "config-a",
          toolSchemaDigest: "tools-a",
          mcpFingerprint: "mcp-a",
          resolvedContextDigest: "context-a",
        })
        yield* turns.setStatus(Turn.TurnId.make("turn-a"), "completed", "cursor-a", 4)
      }).pipe(provideLayer(layer))
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.merge(
        ThreadRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        TurnRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      return yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        return { thread: yield* repository.get(id), turn: yield* turns.get(Turn.TurnId.make("turn-a")) }
      }).pipe(provideLayer(reopened))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      program.pipe(
        provideLayer(BunServices.layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.thread?.title).toBe("First")
            expect(result.thread?.labels).toEqual(["local"])
            expect(result.turn?.status).toBe("completed")
            expect(result.turn?.lastCursor).toBe("cursor-a")
            expect(result.turn?.extensionPin).toEqual({
              generation: "generation-a",
              sourceDigest: "source-a",
              configFingerprint: "config-a",
              toolSchemaDigest: "tools-a",
              mcpFingerprint: "mcp-a",
              resolvedContextDigest: "context-a",
            })
          }),
        ),
      ),
    ),
  )
})

test("upgrades a seeded pre-v7 database and preserves legacy active and queued rows", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persistence-v5-" })
      const filename = `${directory}/rika.db`
      const { Database: BunDatabase } = yield* Effect.promise(() => import("bun:sqlite"))
      const seeded = new BunDatabase(filename)
      seeded.run(
        "CREATE TABLE rika_migrations (migration_id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      )
      seeded.run(
        "INSERT INTO rika_migrations (migration_id, name) VALUES (1, 'product_baseline'), (2, 'turns'), (3, 'queued_turn_status'), (4, 'execution_extension_pins'), (5, 'turn_prompt_parts')",
      )
      seeded.run("CREATE TABLE rika_workspaces (path TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL)")
      seeded.run(
        "CREATE TABLE rika_threads (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL REFERENCES rika_workspaces(path), title TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      )
      seeded.run(
        "CREATE TABLE rika_turns (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')), last_cursor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, extension_pin_json TEXT, prompt_parts_json TEXT)",
      )
      seeded.run("INSERT INTO rika_workspaces (path, created_at) VALUES ('/work/a', 1)")
      seeded.run(
        "INSERT INTO rika_threads (id, session_id, workspace, title, labels_json, pinned, archived, created_at, updated_at) VALUES ('thread-a', 'dead-uuid', '/work/a', 'Seeded', '[\"keep\"]', 1, 0, 1, 2)",
      )
      seeded.run(
        "INSERT INTO rika_turns (id, thread_id, prompt, status, created_at, updated_at) VALUES ('active-turn', 'thread-a', 'active', 'running', 3, 3), ('queued-turn', 'thread-a', 'queued', 'queued', 4, 4)",
      )
      seeded.close()
      const database = Database.layer(filename)
      const result = yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        return { threads: yield* repository.list(), turns: yield* turns.list(id) }
      }).pipe(
        provideLayer(
          Layer.merge(
            ThreadRepository.layer.pipe(Layer.provide(database)),
            TurnRepository.layer.pipe(Layer.provide(database)),
          ),
        ),
      )
      expect(result.threads).toHaveLength(1)
      expect(result.threads[0]?.id).toBe(Thread.ThreadId.make("thread-a"))
      expect(result.threads[0]?.title).toBe("Seeded")
      expect(result.threads[0]?.labels).toEqual(["keep"])
      expect(result.threads[0]?.pinned).toBe(true)
      expect(result.turns).toMatchObject([
        { id: "active-turn", status: "running" },
        { id: "queued-turn", status: "queued" },
      ])
      expect(result.turns.every((turn) => turn.executionRoute === undefined)).toBe(true)
    }),
  ).pipe(provideLayer(BunServices.layer))
  return Effect.runPromise(Effect.scoped(program))
})

test("turn SQL mutations, ordering, and rejection branches", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-turns-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.merge(
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      return yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({
          id,
          workspace: "/work",
          title: "A",
          now: 1,
        })
        const active = yield* turns.createForSubmission({
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "a",
          now: 2,
        })
        const second = yield* turns.createForSubmission({
          id: Turn.TurnId.make("second"),
          threadId: id,
          prompt: "b",
          now: 3,
        })
        const third = yield* turns.createForSubmission({
          id: Turn.TurnId.make("third"),
          threadId: id,
          prompt: "c",
          now: 4,
        })
        expect((yield* turns.findActive(id))?.id).toBe(active.id)
        expect((yield* turns.listQueued(id)).map((turn) => turn.id)).toEqual([second.id, third.id])
        expect((yield* turns.listNonterminal).map((turn) => turn.id)).toEqual([active.id, second.id, third.id])
        expect(yield* turns.claimNextQueued(id, 5)).toBeUndefined()
        expect((yield* turns.editQueued(second.id, "edited", 6)).prompt).toBe("edited")
        expect((yield* Effect.result(turns.editQueued(active.id, "no", 6)))._tag).toBe("Failure")
        expect((yield* Effect.result(turns.dequeue(active.id)))._tag).toBe("Failure")
        yield* turns.dequeue(third.id)
        yield* turns.setStatus(active.id, "completed", undefined, 7)
        expect((yield* turns.claimNextQueued(id, 8))?.id).toBe(second.id)
        expect((yield* turns.list(id)).map((turn) => turn.id)).toEqual([active.id, second.id])
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
