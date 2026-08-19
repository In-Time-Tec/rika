import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as ThreadSummaryRepository from "../src/summary/sqlite-thread-summary-repository"
import * as ThreadSearchRepository from "../src/search/sqlite-thread-search-repository"
import * as ProductDatabase from "../src/database/product-database-layer"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

it.layer(BunServices.layer)("thread deletion persistence", (test) => {
  test.effect("hides tombstones, rejects admissions, and physically deletes cascades and outbox", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-thread-deletion-" })
        const database = ProductDatabase.layer(`${directory}/rika.db`)
        const adapters = Layer.mergeAll(
          database,
          ThreadRepository.layer.pipe(Layer.provide(database)),
          ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
          ThreadSearchRepository.layer.pipe(Layer.provide(database)),
        )
        const context = yield* Layer.build(adapters)
        const repository = Context.get(context, ThreadRepository.Service)
        const summaries = Context.get(context, ThreadSummaryRepository.Service)
        const search = Context.get(context, ThreadSearchRepository.Service)
        const sql = Context.get(context, SqlClient)
        const threadId = Thread.ThreadId.make("thread-a")
        yield* repository.create({ id: threadId, workspace: "/work", title: "Thread", now: 1 })
        yield* sql`INSERT INTO rika_turns
          (id, thread_id, prompt, status, execution_route_json, created_at, updated_at)
          VALUES ('turn-a', ${threadId}, 'first', 'running', '{}', 1, 1)`
        yield* sql`INSERT INTO rika_thread_search
          (thread_id, title, labels, human_prompts, agent_prompts, root_assistant, child_assistant, files)
          VALUES (${threadId}, 'Thread', '', 'first', '', '', '', '')`
        yield* repository.requestDeletion(threadId, 2)
        expect(yield* repository.get(threadId)).toBeUndefined()
        expect(yield* repository.list({ includeArchived: true })).toEqual([])
        expect(yield* summaries.list({ includeArchived: true })).toEqual([])
        expect((yield* search.search({ workspace: "/work", query: "first" })).results).toEqual([])
        expect(yield* sql`SELECT id FROM rika_threads WHERE id = ${threadId}`).toHaveLength(1)
        expect(yield* repository.pendingDeletions).toEqual([{ threadId, requestedAt: 2 }])
        expect(
          (yield* Effect.exit(
            sql`INSERT INTO rika_turns
              (id, thread_id, prompt, status, execution_route_json, created_at, updated_at)
              VALUES ('turn-b', ${threadId}, 'late', 'accepted', '{}', 2, 2)`,
          ))._tag,
        ).toBe("Failure")
        yield* repository.completeDeletion(threadId)
        expect(yield* repository.pendingDeletions).toEqual([])
        expect(yield* sql`SELECT id FROM rika_threads WHERE id = ${threadId}`).toEqual([])
        expect(yield* sql`SELECT id FROM rika_turns WHERE thread_id = ${threadId}`).toEqual([])
        expect(yield* sql`SELECT thread_id FROM rika_thread_deletion_outbox WHERE thread_id = ${threadId}`).toEqual([])
      }),
    ),
  )
})
