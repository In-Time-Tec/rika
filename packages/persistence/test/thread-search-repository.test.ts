import * as BunServices from "@effect/platform-bun/BunServices"
import * as Transcript from "@rika/transcript"
import { describe, expect, it } from "@effect/vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import * as Database from "../src/product-database"
import * as ThreadRepository from "../src/thread-repository"
import * as Search from "../src/thread-search-repository"
import * as Thread from "../src/thread-schema"
import * as Turn from "../src/turn-schema"

const provideBun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const thread = (id: string, updatedAt: number, archived = false): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work/current",
  title: `Search ${id}`,
  labels: ["foundation"],
  pinned: false,
  archived,
  lineage: { _tag: "Original" },
  createdAt: updatedAt - 1,
  updatedAt,
})

const turn = (target: Thread.Thread, prompt: string): Turn.Turn => ({
  id: Turn.TurnId.make(`turn-${target.id}`),
  threadId: target.id,
  prompt,
  status: "completed",
  stopIntent: "none",
  executionRoute: Turn.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: target.createdAt,
  updatedAt: target.updatedAt,
})

const assistant = (target: Turn.Turn, text: string, parentId?: string): Transcript.Unit => ({
  key: `${target.id}:${parentId ?? "root"}:${text}`,
  turnId: target.id,
  ...(parentId === undefined ? {} : { parentId }),
  order: { sequence: 1, part: 0 },
  revision: 1,
  content: { _tag: "Entry", role: "assistant", text },
})

const edit = (target: Turn.Turn, path: string, status: "complete" | "failed"): Transcript.Unit => ({
  key: `${target.id}:edit:${path}:${status}`,
  turnId: target.id,
  order: { sequence: 2, part: 0 },
  revision: 2,
  content: {
    _tag: "Block",
    block: {
      _tag: "ToolCall",
      id: "edit",
      name: "apply_patch",
      input: "raw secret input",
      status,
      presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
      detail: "raw command detail",
      output: "raw shell output",
      files: [
        { key: path, path, kind: "update", patch: "secret diff", additions: 1, deletions: 1, preview: false, status },
      ],
    },
  },
})

const exercise = (repository: Search.Interface) =>
  Effect.gen(function* () {
    const first = thread("a", 20)
    const second = thread("b", 20, true)
    const firstTurn = turn(first, "quoted human needle")
    const secondTurn = turn(second, "archived needle")
    yield* repository.rebuildThread({
      thread: first,
      turns: [firstTurn],
      units: [
        assistant(firstTurn, "final root answer"),
        assistant(firstTurn, "nested child conclusion", `${firstTurn.id}:agent`),
        edit(firstTurn, "src/success.ts", "complete"),
        edit(firstTurn, "src/failed.ts", "failed"),
        {
          ...assistant(firstTurn, "private chain of thought"),
          content: { _tag: "Block", block: { _tag: "Reasoning", text: "private chain of thought" } },
        },
      ],
    })
    yield* repository.rebuildThread({ thread: second, turns: [secondTurn], units: [] })
    const metadata = yield* repository.search({ workspace: first.workspace, query: "foundation" })
    const quoted = yield* repository.search({ workspace: first.workspace, query: '"human needle"' })
    const file = yield* repository.search({ workspace: first.workspace, query: "file:src/success.ts" })
    const child = yield* repository.search({ workspace: first.workspace, query: "conclusion" })
    const failed = yield* repository.search({ workspace: first.workspace, query: "failed.ts" })
    const raw = yield* repository.search({ workspace: first.workspace, query: "secret" })
    const archive = yield* repository.search({
      workspace: first.workspace,
      query: "needle",
      includeArchived: true,
      limit: 1,
    })
    const next = yield* repository.search({
      workspace: first.workspace,
      query: "needle",
      includeArchived: true,
      ...(archive.nextCursor === undefined ? {} : { cursor: archive.nextCursor }),
    })
    const unsupported = yield* Effect.result(repository.search({ workspace: first.workspace, query: "author:dallen" }))
    yield* repository.rebuildThread({
      thread: { ...first, title: "Updated title", updatedAt: 30 },
      turns: [],
      units: [],
    })
    const removedContent = yield* repository.search({
      workspace: first.workspace,
      query: "needle",
      includeArchived: true,
    })
    yield* repository.removeThread(first.id)
    const removed = yield* repository.search({ workspace: first.workspace, query: "Updated" })
    return {
      metadata: metadata.results.map((result) => [result.threadId, result.matchedBy]),
      quoted: quoted.results.map((result) => result.threadId),
      file: file.results.map((result) => result.threadId),
      child: child.results.map((result) => result.matchedBy),
      failed: failed.results.length,
      raw: raw.results.length,
      pages: [archive.results[0]?.threadId, next.results[0]?.threadId],
      unsupported: unsupported._tag,
      removedContent: removedContent.results.map((result) => result.threadId),
      removed: removed.results.length,
    }
  })

describe("thread search repository", () => {
  it.effect("keeps memory and SQLite search, filtering, cursor, update, and deletion behavior equal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-search-" })
        const database = Database.layer(`${directory}/rika.db`)
        const context = yield* Layer.build(
          Layer.mergeAll(
            database,
            Search.layer.pipe(Layer.provide(database)),
            ThreadRepository.layer.pipe(Layer.provide(database)),
          ),
        )
        const memory = yield* Search.makeMemory
        const sql = yield* Search.Service.pipe(Effect.provide(context))
        const threads = yield* ThreadRepository.Service.pipe(Effect.provide(context))
        for (const target of [thread("a", 20), thread("b", 20, true)]) {
          yield* threads.create({
            id: target.id,
            workspace: target.workspace,
            title: target.title,
            now: target.createdAt,
          })
          yield* threads.label(target.id, target.labels, target.updatedAt)
          if (target.archived) yield* threads.setArchived(target.id, true, target.updatedAt)
        }
        const memoryResult = yield* exercise(memory)
        const sqlResult = yield* exercise(sql)
        expect(sqlResult).toEqual(memoryResult)
        expect(sqlResult).toMatchObject({
          failed: 0,
          raw: 0,
          pages: [Thread.ThreadId.make("a"), Thread.ThreadId.make("b")],
          unsupported: "Failure",
          removedContent: [Thread.ThreadId.make("b")],
          removed: 0,
        })
        expect(sqlResult.child).toEqual([["childAssistant"]])
        expect(sqlResult.file).toEqual([Thread.ThreadId.make("a")])
      }).pipe(provideBun),
    ),
  )

  it.effect("migrates schema 16 and backfills titles, labels, and existing prompts as Human", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-search-backfill-" })
        const filename = `${directory}/rika.db`
        yield* Layer.build(Database.layer(filename))
        yield* Effect.sync(() => {
          const database = new NativeDatabase(filename)
          database.exec(`
          DROP TRIGGER rika_thread_picker_summary_thread_insert;
          DROP TRIGGER rika_thread_picker_summary_thread_update;
          DROP TRIGGER rika_thread_picker_summary_turn_insert;
          DROP TRIGGER rika_thread_picker_summary_turn_update;
          DROP TRIGGER rika_thread_picker_summary_turn_before_delete;
          DROP TRIGGER rika_thread_picker_summary_turn_delete;
          DROP TRIGGER rika_thread_picker_summary_activity_insert;
          DROP TRIGGER rika_thread_picker_summary_activity_update;
          DROP TRIGGER rika_thread_picker_summary_activity_delete;
          DROP TABLE rika_thread_picker_summary;
          DROP INDEX rika_turns_thread_updated;
          DROP INDEX rika_turns_thread_nonqueued;
          DROP TABLE rika_usage_repairs;
          DROP TABLE rika_turn_usage;
          DROP TABLE rika_thread_search;
          DROP TABLE rika_thread_search_files;
          DROP TABLE rika_thread_relationships;
          DROP TABLE rika_thread_invocation_receipts;
          DROP TABLE rika_thread_result_routes;
          DROP TABLE rika_thread_root_readiness;
          ALTER TABLE rika_threads DROP COLUMN lineage_json;
          ALTER TABLE rika_turns DROP COLUMN author_json;
          ALTER TABLE rika_turns DROP COLUMN lineage_json;
          ALTER TABLE rika_turns DROP COLUMN stop_intent;
          DELETE FROM rika_migrations WHERE migration_id IN (17, 18, 19, 20, 21);
          INSERT INTO rika_workspaces (path, created_at) VALUES ('/work/current', 1);
          INSERT INTO rika_threads (id, workspace, title, labels_json, created_at, updated_at)
            VALUES ('legacy', '/work/current', 'Legacy title', '["legacy-label"]', 1, 2);
          INSERT INTO rika_turns (id, thread_id, prompt, status, execution_route_json, created_at, updated_at)
            VALUES ('legacy-turn', 'legacy', 'historical prompt', 'completed', '${encodeJson(Turn.testExecutionRoute()).replaceAll("'", "''")}', 1, 2);
        `)
          database.close()
        })
        const database = Database.layer(filename)
        const context = yield* Layer.build(Layer.mergeAll(database, Search.layer.pipe(Layer.provide(database))))
        const repository = yield* Search.Service.pipe(Effect.provide(context))
        const result = yield* repository.search({ workspace: "/work/current", query: "historical" })
        expect(result.results).toMatchObject([{ threadId: "legacy", matchedBy: ["humanPrompt"] }])
      }).pipe(provideBun),
    ),
  )
})
