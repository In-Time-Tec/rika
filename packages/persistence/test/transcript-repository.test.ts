import * as BunServices from "@effect/platform-bun/BunServices"
import * as Transcript from "@rika/transcript"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "../src/product-database"
import * as Thread from "../src/thread-schema"
import * as ThreadRepository from "../src/thread-repository"
import * as TranscriptRepository from "../src/transcript-repository"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

const turn = (index: number): Turn.Turn => ({
  id: Turn.TurnId.make(`turn-${index}`),
  threadId: Thread.ThreadId.make("thread-a"),
  prompt: `prompt ${index}`,
  executionRoute: Turn.testExecutionRoute(),
  status: "completed",
  createdAt: index,
  updatedAt: index,
})

const event = (index: number): Transcript.SourceEvent => ({
  cursor: `cursor-${index}`,
  sequence: index,
  type: index === 2 ? "execution.completed" : "model.output.completed",
  createdAt: index,
  text: `output ${index}`,
})

const semanticUnit = (turnId: Turn.TurnId, sequence: number, part: number, key: string): Transcript.Unit => ({
  key,
  turnId,
  order: { sequence, part },
  revision: 0,
  content: { _tag: "Entry", role: "assistant", text: key },
})

it.layer(TranscriptRepository.memoryLayer)("transcript repository", (test) => {
  test.effect("stores a bounded semantic projection and ignores duplicate source events", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const first = Transcript.project(turn(1).id, turn(1).prompt, [event(0), event(1)])
      yield* repository.replace(turn(1), first)
      const appended = yield* repository.appendAll(turn(1), [event(2)])
      const duplicate = yield* repository.append(turn(1), event(2))
      expect(appended.units.map((item) => item.content._tag)).toEqual(["Entry", "Entry"])
      expect(appended.revision).toBe(2)
      expect(duplicate.revision).toBe(2)
      expect(duplicate.checkpointCursor).toBe("cursor-2")
    }),
  )

  test.effect("appends a resumed suffix without replacing earlier semantic units", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(4), threadId: Thread.ThreadId.make("thread-resumed") }
      yield* repository.replace(target, Transcript.project(target.id, target.prompt, [event(0)]))
      const resumed = yield* repository.appendAll(target, [
        {
          cursor: "permission-1",
          sequence: 1,
          type: "permission.ask.requested",
          createdAt: 1,
          data: { wait_id: "wait-1", title: "Allow work" },
        },
        { cursor: "resumed-input", sequence: 2, type: "model.input.prepared", createdAt: 2 },
        {
          cursor: "resumed-2",
          sequence: 3,
          type: "model.output.completed",
          createdAt: 3,
          text: "resumed output",
        },
      ])
      expect(
        resumed.units.flatMap((item) =>
          item.content._tag === "Entry" && item.content.role === "assistant" ? [item.content.text] : [],
        ),
      ).toEqual(["output 0", "resumed output"])
      expect(resumed.checkpointCursor).toBe("resumed-2")
    }),
  )

  test.effect("does not let an older rebuild overwrite a newer projection", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(7), threadId: Thread.ThreadId.make("thread-b") }
      const newer = Transcript.project(target.id, target.prompt, [event(0), event(1)])
      const older = Transcript.project(target.id, target.prompt, [event(0)])
      yield* repository.replace(target, newer)
      expect(yield* repository.replace(target, older)).toMatchObject({
        revision: 1,
        checkpointCursor: "cursor-1",
      })
    }),
  )

  test.effect("pages semantic units across and within turns in chronological order", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      for (let index = 0; index < 3; index += 1)
        yield* repository.replace(turn(index), Transcript.project(turn(index).id, turn(index).prompt, [event(index)]))
      const newest = yield* repository.page(Thread.ThreadId.make("thread-a"), { limit: 3 })
      const older = yield* repository.page(Thread.ThreadId.make("thread-a"), {
        before: newest.oldestCursor,
        limit: 3,
      })
      expect(newest.entries.map((entry) => [entry.turn.id, entry.unit.content._tag])).toEqual([
        [Turn.TurnId.make("turn-1"), "Entry"],
        [Turn.TurnId.make("turn-1"), "Entry"],
        [Turn.TurnId.make("turn-2"), "Entry"],
      ])
      expect(newest.hasOlder).toBe(true)
      expect(older.entries.map((entry) => entry.turn.id)).toEqual([
        Turn.TurnId.make("turn-0"),
        Turn.TurnId.make("turn-0"),
      ])
    }),
  )

  test.effect("uses every keyset field without duplicates or gaps across tied pages", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const threadId = Thread.ThreadId.make("thread-keyset")
      const tiedTurns = [
        Object.assign(turn(40), { id: Turn.TurnId.make("turn-a"), threadId, createdAt: 100, updatedAt: 100 }),
        Object.assign(turn(40), { id: Turn.TurnId.make("turn-b"), threadId, createdAt: 100, updatedAt: 100 }),
      ]
      for (const target of tiedTurns) {
        const units = [
          semanticUnit(target.id, 1, 0, `${target.id}:sequence`),
          semanticUnit(target.id, 1, 1, `${target.id}:part-a`),
          semanticUnit(target.id, 1, 1, `${target.id}:part-b`),
          semanticUnit(target.id, 2, 0, `${target.id}:latest`),
        ]
        yield* repository.replace(target, { ...Transcript.empty(target.id, target.prompt), units })
      }

      const collected: Array<TranscriptRepository.Entry> = []
      let cursor: TranscriptRepository.PageCursor | undefined
      do {
        const page = yield* repository.page(threadId, { before: cursor, limit: 2 })
        collected.unshift(...page.entries)
        cursor = page.hasOlder ? page.oldestCursor : undefined
        if (!page.hasOlder) break
      } while (cursor !== undefined)

      expect(collected.map((entry) => entry.unit.key)).toEqual([
        "turn-a:sequence",
        "turn-a:part-a",
        "turn-a:part-b",
        "turn-a:latest",
        "turn-b:sequence",
        "turn-b:part-a",
        "turn-b:part-b",
        "turn-b:latest",
      ])
      expect(new Set(collected.map((entry) => entry.unit.key)).size).toBe(collected.length)
    }),
  )

  test.effect("clamps page limits to one and two hundred", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(41), threadId: Thread.ThreadId.make("thread-limits") }
      const units: Array<Transcript.Unit> = Array.from({ length: 201 }, (_, index) => ({
        key: `${target.id}:unit-${String(index).padStart(3, "0")}`,
        turnId: target.id,
        order: { sequence: index, part: 0 },
        revision: 0,
        content: { _tag: "Entry", role: "assistant", text: String(index) },
      }))
      yield* repository.replace(target, { ...Transcript.empty(target.id, target.prompt), units })

      const minimum = yield* repository.page(target.threadId, { limit: 0 })
      const maximum = yield* repository.page(target.threadId, { limit: 999 })
      expect(minimum.entries).toHaveLength(1)
      expect(minimum.hasOlder).toBe(true)
      expect(maximum.entries).toHaveLength(200)
      expect(maximum.hasOlder).toBe(true)
      expect(maximum.entries.map((entry) => entry.unit.order.sequence)).toEqual(
        Array.from({ length: 200 }, (_, index) => index + 1),
      )
    }),
  )

  test.effect("reloads interleaved units in the same order the projection built them", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(31), threadId: Thread.ThreadId.make("thread-order") }
      const projection = Transcript.project(target.id, target.prompt, [
        { cursor: "prepared", sequence: 0, type: "model.input.prepared", createdAt: 0 },
        { cursor: "reason", sequence: 1, type: "model.reasoning.delta", createdAt: 1, text: "thinking" },
        { cursor: "answer", sequence: 2, type: "model.output.completed", createdAt: 2, text: "answer" },
        {
          cursor: "call",
          sequence: 3,
          type: "tool.call.requested",
          createdAt: 3,
          data: { call_id: "call-a", name: "read_file", input: { path: "x.ts" } },
        },
        {
          cursor: "result",
          sequence: 4,
          type: "tool.result.received",
          createdAt: 4,
          data: { tool_call_id: "call-a", output: "contents" },
        },
      ])
      yield* repository.replace(target, projection)
      const page = yield* repository.page(Thread.ThreadId.make("thread-order"), { limit: 200 })
      expect(page.entries.map((entry) => entry.unit.key)).toEqual(projection.units.map((unit) => unit.key))
      expect(page.entries.map((entry) => entry.unit.content._tag)).toEqual(["Entry", "Block", "Entry", "Block"])
    }),
  )

  test.effect("round-trips a completed subagent tree through the durable page shape", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(32), threadId: Thread.ThreadId.make("thread-subagent") }
      const childId = "turn-32:child:agent"
      const parent = Transcript.project(target.id, target.prompt, [
        {
          cursor: "agent",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: {
            tool_call_id: "agent",
            tool_name: "transfer_to_oracle",
            input: { input: [{ type: "text", text: "Review the projection" }] },
          },
        },
        {
          cursor: "spawned",
          sequence: 1,
          type: "child_run.spawned",
          createdAt: 1,
          data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
        },
        {
          cursor: "result",
          sequence: 2,
          type: "tool.result.received",
          createdAt: 2,
          data: {
            tool_call_id: "agent",
            output:
              '{"status":"completed","output":[{"type":"text","text":"## Review complete\\n\\n**No defects found.**"}]}',
          },
        },
        { cursor: "done", sequence: 3, type: "execution.completed", createdAt: 3 },
      ])
      const child = Transcript.project(childId, "", [
        {
          cursor: "read",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/projection.ts" } },
        },
        {
          cursor: "answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 1,
          text: "## Review complete\n\n**No defects found.**",
        },
        { cursor: "child-done", sequence: 2, type: "execution.completed", createdAt: 2 },
      ])
      const live = Transcript.withNestedProjections(parent, [{ parentId: `${target.id}:agent`, projection: child }])

      yield* repository.replace(target, live)
      const page = yield* repository.page(target.threadId, { limit: 200 })

      expect(page.entries.map((entry) => entry.unit)).toEqual(live.units)
      expect(page.entries.filter((entry) => entry.unit.parentId === `${target.id}:agent`)).toHaveLength(
        child.units.length,
      )
      expect(
        page.entries.some(
          (entry) =>
            entry.unit.parentId === `${target.id}:agent` &&
            entry.unit.content._tag === "Entry" &&
            entry.unit.content.role === "assistant" &&
            entry.unit.content.text === "## Review complete\n\n**No defects found.**",
        ),
      ).toBe(true)
    }),
  )

  test.effect("returns one page-independent thread cost and restores projection fold state", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const firstTurn = turn(21)
      const secondTurn = turn(22)
      const first = {
        ...Transcript.project(firstTurn.id, firstTurn.prompt, [
          { cursor: "phase", sequence: 0, type: "model.input.prepared", createdAt: 0 },
        ]),
        costUsd: 1.25,
      }
      const second = { ...Transcript.empty(secondTurn.id, secondTurn.prompt), costUsd: 2.5 }
      yield* repository.replace(firstTurn, first)
      yield* repository.replace(secondTurn, second)
      const stored = yield* repository.get(firstTurn.id)
      const page = yield* repository.page(Thread.ThreadId.make("thread-a"), { limit: 1 })
      expect(stored).toMatchObject({ modelPhase: 0 })
      expect(page.threadCostUsd).toBe(3.75)
    }),
  )
})

it.effect("returns a typed repository error for a malformed durable unit after reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-page-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-durable-page")
      const targetId = Turn.TurnId.make("turn-durable-page")
      const makeLayer = () => {
        const database = Database.layer(filename)
        return Layer.mergeAll(
          database,
          ThreadRepository.layer.pipe(Layer.provide(database)),
          TurnRepository.layer.pipe(Layer.provide(database)),
          TranscriptRepository.layer.pipe(Layer.provide(database)),
        )
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          yield* threads.create({ id: threadId, workspace: "/work/page", title: "Page", now: 1 })
          const created = yield* turns.createForSubmission({
            id: targetId,
            threadId,
            prompt: "persist me",
            executionRoute: Turn.testExecutionRoute(),
            queueCapacity: 128,
            now: 2,
          })
          yield* turns.setStatus(targetId, "completed", undefined, 3)
          const target = yield* turns.get(targetId)
          if (target === undefined) return yield* Effect.die("turn was not stored")
          yield* transcripts.replace(target, Transcript.project(target.id, target.prompt, [event(0)]))
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${"{"} WHERE turn_id = ${targetId}`
          expect(created.id).toBe(targetId)
        }).pipe(provideLayer(makeLayer())),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          const failure = yield* Effect.flip(transcripts.page(threadId, { limit: 1 }))
          expect(failure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(failure._tag).toBe("TranscriptRepositoryError")
        }).pipe(provideLayer(makeLayer())),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
