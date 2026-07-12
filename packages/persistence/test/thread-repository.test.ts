import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as ThreadRepository from "../src/thread-repository"
import * as Thread from "../src/thread-schema"
import { makeRecordingSql } from "./recording-sql"

const id = (value: string) => Thread.ThreadId.make(value)

const behavior = (name: string, layer: Layer.Layer<ThreadRepository.Service>) => {
  describe(name, () => {
    it.effect("supports the complete metadata lifecycle", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const first = yield* repository.create({
          id: id("thread-a"),
          workspace: "/work/a",
          title: "First",
          now: 1,
        })
        yield* repository.create({
          id: id("thread-b"),
          workspace: "/work/b",
          title: "Second",
          now: 2,
        })
        const renamed = yield* repository.rename(first.id, "Renamed", 3)
        const labeled = yield* repository.label(first.id, ["bug", "bug", "urgent"], 4)
        const pinned = yield* repository.setPinned(first.id, true, 5)
        const archived = yield* repository.setArchived(id("thread-b"), true, 6)
        const visible = yield* repository.list()
        const all = yield* repository.list({ includeArchived: true })
        const search = yield* repository.list({ includeArchived: true, query: "urgent" })
        const bounded = yield* repository.list({ includeArchived: true, limit: 0 })
        yield* repository.remove(first.id)
        const removed = yield* repository.get(first.id)
        expect(renamed.title).toBe("Renamed")
        expect(labeled.labels).toEqual(["bug", "urgent"])
        expect(pinned.pinned).toBe(true)
        expect(archived.archived).toBe(true)
        expect(visible.map((thread) => thread.id)).toEqual([id("thread-a")])
        expect(all.map((thread) => thread.id)).toEqual([id("thread-a"), id("thread-b")])
        expect(search.map((thread) => thread.id)).toEqual([id("thread-a")])
        expect(bounded).toHaveLength(1)
        expect(removed).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )

    it.effect("reports duplicate and missing records", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const input = {
          id: id("thread-a"),
          workspace: "/work/a",
          title: "First",
          now: 1,
        }
        yield* repository.create(input)
        const duplicate = yield* Effect.result(repository.create(input))
        const missing = yield* Effect.result(repository.rename(id("missing"), "No", 2))
        expect(duplicate._tag).toBe("Failure")
        expect(missing._tag).toBe("Failure")
      }).pipe(Effect.provide(layer)),
    )
  })
}

behavior("memory", ThreadRepository.memoryLayer())

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "thread-a",
  workspace: "/work/a",
  title: "First",
  labels_json: "[]",
  pinned: 0,
  archived: 0,
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

const sqlTest = (
  run: (
    sql: ReturnType<typeof makeRecordingSql>,
  ) => Effect.Effect<void, ThreadRepository.RepositoryError, ThreadRepository.Service>,
) => {
  const sql = makeRecordingSql()
  return run(sql).pipe(Effect.provide(ThreadRepository.layer.pipe(Layer.provide(sql.layer))))
}

describe("sql layer", () => {
  it.effect("creates a workspace and thread and decodes the inserted row", () =>
    sqlTest((sql) =>
      Effect.gen(function* () {
        sql.rows()
        sql.rows()
        sql.rows(row())
        const repository = yield* ThreadRepository.Service
        const created = yield* repository.create({
          id: id("thread-a"),
          workspace: "/work/a",
          title: "First",
          now: 1,
        })
        expect(created.labels).toEqual([])
        expect(sql.statements.map((statement) => statement.sql)).toEqual([
          "INSERT INTO rika_workspaces (path, created_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING",
          "INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, created_at, updated_at) VALUES (?, ?, ?, '[]', 0, 0, ?, ?)",
          "SELECT * FROM rika_threads WHERE id = ?",
        ])
        expect(sql.statements[1]?.parameters).toEqual(["thread-a", "/work/a", "First", 1, 1])
      }),
    ),
  )

  it.effect("gets found and missing threads", () =>
    sqlTest((sql) =>
      Effect.gen(function* () {
        sql.rows(row({ labels_json: '["bug"]', pinned: 1, archived: 1 }))
        sql.rows()
        const repository = yield* ThreadRepository.Service
        const found = yield* repository.get(id("thread-a"))
        const missing = yield* repository.get(id("missing"))
        expect(found).toMatchObject({ labels: ["bug"], pinned: true, archived: true })
        expect(missing).toBeUndefined()
      }),
    ),
  )

  it.effect("filters, searches, sorts, and clamps list limits", () =>
    sqlTest((sql) =>
      Effect.gen(function* () {
        const rows = [
          row({ id: "b", workspace: "/other", title: "Other", updated_at: 5 }),
          row({ id: "a", labels_json: '["Urgent"]', pinned: 1, updated_at: 2 }),
          row({ id: "c", title: "Archived", archived: 1, updated_at: 9 }),
        ]
        sql.rows(...rows)
        sql.rows(...rows)
        sql.rows(...rows)
        sql.rows(...Array.from({ length: 101 }, (_, index) => row({ id: `x-${index}`, updated_at: index })))
        const repository = yield* ThreadRepository.Service
        expect((yield* repository.list()).map((thread) => thread.id)).toEqual([id("a"), id("b")])
        expect(
          (yield* repository.list({ includeArchived: true, query: "urgent", limit: 0 })).map((thread) => thread.id),
        ).toEqual([id("a")])
        expect(yield* repository.list({ includeArchived: true, query: "/OTHER", limit: 200 })).toHaveLength(1)
        expect(yield* repository.list({ includeArchived: true, limit: 200 })).toHaveLength(100)
      }),
    ),
  )

  it.effect("binds deduplicated and optional update fields", () =>
    sqlTest((sql) =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const cases = [
          [
            () => repository.rename(id("thread-a"), "Renamed", 2),
            ["Renamed", null, null, null, 2, "thread-a"],
            row({ title: "Renamed", updated_at: 2 }),
          ],
          [
            () => repository.label(id("thread-a"), ["bug", "bug"], 3),
            [null, '["bug"]', null, null, 3, "thread-a"],
            row({ labels_json: '["bug"]', updated_at: 3 }),
          ],
          [
            () => repository.setPinned(id("thread-a"), true, 4),
            [null, null, 1, null, 4, "thread-a"],
            row({ pinned: 1, updated_at: 4 }),
          ],
          [
            () => repository.setArchived(id("thread-a"), false, 5),
            [null, null, null, 0, 5, "thread-a"],
            row({ updated_at: 5 }),
          ],
        ] satisfies ReadonlyArray<
          readonly [
            () => Effect.Effect<Thread.Thread, ThreadRepository.RepositoryError>,
            ReadonlyArray<unknown>,
            object,
          ]
        >
        for (const [operation, parameters, updated] of cases) {
          sql.rows(row())
          sql.rows()
          sql.rows(updated)
          yield* operation()
          expect(sql.statements.at(-2)?.parameters).toEqual(parameters)
        }
      }),
    ),
  )

  it.effect("removes existing threads and rejects missing removals", () =>
    sqlTest((sql) =>
      Effect.gen(function* () {
        sql.rows(row())
        sql.rows()
        sql.rows()
        const repository = yield* ThreadRepository.Service
        yield* repository.remove(id("thread-a"))
        const missing = yield* Effect.result(repository.remove(id("missing")))
        expect(sql.statements[1]).toEqual({ sql: "DELETE FROM rika_threads WHERE id = ?", parameters: ["thread-a"] })
        expect(missing._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("maps malformed rows and SQL failures to repository errors", () =>
    sqlTest((sql) =>
      Effect.gen(function* () {
        sql.rows(row({ labels_json: "not-json" }))
        sql.error("database unavailable")
        const repository = yield* ThreadRepository.Service
        const malformed = yield* Effect.result(repository.get(id("thread-a")))
        const failed = yield* Effect.result(repository.list())
        expect(malformed._tag === "Failure" && malformed.failure._tag).toBe("ThreadRepositoryError")
        expect(failed._tag === "Failure" && failed.failure._tag).toBe("ThreadRepositoryError")
      }),
    ),
  )
})
