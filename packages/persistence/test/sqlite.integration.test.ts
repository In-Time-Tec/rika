import * as BunServices from "@effect/platform-bun/BunServices"
import * as Transcript from "@rika/transcript"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Database, Thread, ThreadRepository, ThreadSummaryRepository } from "../src"
import * as TurnRepository from "../src/turn-repository"
import * as TranscriptRepository from "../src/transcript-repository"
import * as Turn from "../src/turn-schema"

const id = Thread.ThreadId.make("thread-a")

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

test("creates, persists, and reopens the current schema", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persistence-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
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
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 5,
        })
        yield* summaries.markRead(id, 6)
        const transcript = yield* TranscriptRepository.Service
        const storedTurn = yield* turns.get(Turn.TurnId.make("turn-a"))
        if (storedTurn === undefined) return yield* Effect.die("turn-a was not stored")
        yield* transcript.replace(
          storedTurn,
          Transcript.project(storedTurn.id, storedTurn.prompt, [
            { cursor: "cursor-a", sequence: 1, type: "execution.completed", createdAt: 4 },
          ]),
        )
        yield* transcript.append(storedTurn, {
          cursor: "cursor-b",
          sequence: 2,
          type: "model.usage.reported",
          createdAt: 5,
        })
        yield* transcript.append(storedTurn, {
          cursor: "cursor-b",
          sequence: 2,
          type: "model.usage.reported",
          createdAt: 5,
        })
        const sql = yield* SqlClient
        const queryPlan = yield* sql`EXPLAIN QUERY PLAN
          SELECT u.unit_json, c.revision, t.prompt
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id AND c.projection_version = 2
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${id}
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_sequence DESC, u.unit_part DESC, u.unit_key DESC
          LIMIT 51`
        const decodedPlan = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ detail: Schema.String })))(
          queryPlan,
        )
        expect(decodedPlan.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE")
        const cursorPlan = yield* sql`EXPLAIN QUERY PLAN
          SELECT u.unit_json, c.revision, t.prompt
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id AND c.projection_version = 2
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${id} AND
            (u.created_at, u.turn_id, u.unit_sequence, u.unit_part, u.unit_key) <
            (${storedTurn.createdAt}, ${storedTurn.id}, 2, 0, "turn:turn-a:user")
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_sequence DESC, u.unit_part DESC, u.unit_key DESC
          LIMIT 51`
        const decodedCursorPlan = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(cursorPlan)
        const cursorDetails = decodedCursorPlan.map((row) => row.detail).join("\n")
        expect(cursorDetails).toContain("rika_transcript_units_page")
        expect(cursorDetails).toContain("(created_at,turn_id,unit_sequence,unit_part,unit_key)<")
        expect(cursorDetails).not.toContain("TEMP B-TREE")
      }).pipe(provideLayer(layer))
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.mergeAll(
        ThreadRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        TurnRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        ThreadSummaryRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        TranscriptRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      return yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const summaries = yield* ThreadSummaryRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        return {
          thread: yield* repository.get(id),
          turn: yield* turns.get(Turn.TurnId.make("turn-a")),
          summaries: yield* summaries.list(),
          transcript: yield* transcripts.get(Turn.TurnId.make("turn-a")),
        }
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
            expect(result.summaries).toMatchObject([
              {
                id: "thread-a",
                unread: false,
                lastActivityAt: 5,
                editTotals: { added: 3, modified: 2, removed: 1 },
              },
            ])
            expect(result.transcript).toMatchObject({
              revision: 2,
              checkpointCursor: "cursor-b",
              projectionVersion: 2,
              units: [{ content: { _tag: "Entry", role: "user", text: "hello" } }],
            })
          }),
        ),
      ),
    ),
  )
})

test("treats an outdated transcript projection as rebuildable", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-version-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      return yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        const sql = yield* SqlClient
        yield* threads.create({ id, workspace: "/work/a", title: "First", now: 1 })
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("turn-stale"),
          threadId: id,
          prompt: "hello",
          now: 2,
        })
        const turn = yield* turns.get(Turn.TurnId.make("turn-stale"))
        if (turn === undefined) return yield* Effect.die("turn-stale was not stored")
        const projection = Transcript.project(turn.id, turn.prompt, [
          {
            cursor: "cursor-a",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 3,
            data: { tool_call_id: "obsolete", tool_name: "Read", input: "old" },
          },
        ])
        yield* transcripts.replace(turn, projection)
        yield* sql`UPDATE rika_transcript_checkpoints SET projection_version = 1 WHERE turn_id = ${turn.id}`

        expect(yield* transcripts.get(turn.id)).toBeUndefined()
        expect((yield* transcripts.page(id)).entries).toEqual([])
        expect(
          yield* transcripts.appendAll(turn, [
            {
              cursor: "cursor-b",
              sequence: 2,
              type: "model.output.completed",
              createdAt: 4,
              text: "rebuilt",
            },
          ]),
        ).toMatchObject({
          projectionVersion: 2,
          checkpointCursor: "cursor-b",
          units: [
            { content: { _tag: "Entry", role: "user", text: "hello" } },
            { content: { _tag: "Entry", role: "assistant", text: "rebuilt" } },
          ],
        })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
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
