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

const usageData = (inputTokens: number) => ({
  provider: "openai",
  model: "gpt-5.6-sol",
  input_tokens: inputTokens,
  input_tokens_uncached: inputTokens,
  input_tokens_cache_read: 0,
  input_tokens_cache_write: 0,
  output_tokens: 0,
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

  test.effect("keeps replacement monotonic when stale and current rebuilds race", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(8), threadId: Thread.ThreadId.make("thread-race") }
      const stale = Transcript.project(target.id, target.prompt, [event(0)])
      const current = Transcript.project(target.id, target.prompt, [event(0), event(1), event(2)])
      yield* Effect.all(
        [repository.replace(target, stale), repository.replace(target, current), repository.replace(target, stale)],
        { concurrency: "unbounded" },
      )
      expect(yield* repository.get(target.id)).toMatchObject({
        revision: 2,
        checkpointCursor: "cursor-2",
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
          data: { call_id: "call-a", name: "read", input: { path: "x.ts" } },
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
          data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
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

  test.effect("stores the pricing version and accepts a lower current-version rebuild", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(23)
      const stale = { ...Transcript.empty(target.id, target.prompt), costUsd: 15 }
      yield* repository.replace(target, stale)
      expect(yield* repository.get(target.id)).toMatchObject({ costUsd: 15, pricingVersion: undefined })

      const rebuilt = {
        ...Transcript.empty(target.id, target.prompt),
        costUsd: 5,
        pricingVersion: Transcript.pricingVersion,
      }
      expect(yield* repository.replace(target, rebuilt)).toMatchObject({
        costUsd: 5,
        pricingVersion: Transcript.pricingVersion,
      })
    }),
  )

  test.effect("counts redelivered usage once across batches and sums global cost", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = { ...turn(51), threadId: Thread.ThreadId.make("thread-usage") }
      const other = { ...turn(52), id: Turn.TurnId.make("turn-52"), threadId: Thread.ThreadId.make("thread-usage-b") }
      const usage: Transcript.SourceEvent = {
        id: "event-usage-1",
        executionId: "execution:turn-51",
        cursor: "usage-1",
        sequence: 5,
        type: "model.usage.reported",
        createdAt: 5,
        data: usageData(250_000),
      }
      const before = yield* repository.globalCostUsd
      yield* repository.appendAll(target, [usage])
      const redelivered = yield* repository.appendAll(target, [
        usage,
        {
          id: "event-late-usage",
          executionId: "execution:turn-51",
          cursor: "late-usage",
          sequence: 2,
          type: "model.usage.reported",
          createdAt: 6,
          data: usageData(150_000),
        },
        { cursor: "completed", sequence: 6, type: "execution.completed", createdAt: 7 },
      ])
      yield* repository.replace(other, { ...Transcript.empty(other.id, other.prompt), costUsd: 0.5 })
      const after = yield* repository.globalCostUsd
      expect(redelivered.costUsd).toBeCloseTo(2, 10)
      expect(redelivered.usageCursors).toEqual([
        "execution:turn-51\u0000event-usage-1",
        "execution:turn-51\u0000event-late-usage",
      ])
      expect(after - before).toBeCloseTo(2.5, 10)
    }),
  )
})

it.effect("persists an execution outcome appended after the initial projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-outcome-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-durable-outcome")
      const targetId = Turn.TurnId.make("turn-durable-outcome")
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id: threadId, workspace: "/work/outcome", title: "Outcome", now: 1 })
          yield* turns.createForSubmission({
            id: targetId,
            threadId,
            prompt: "persist completion",
            executionRoute: Turn.testExecutionRoute(),
            queueCapacity: 128,
            now: 2,
          })
          yield* turns.setStatus(targetId, "completed", undefined, 3)
          const target = yield* turns.get(targetId)
          if (target === undefined) return yield* Effect.die("turn was not stored")
          yield* transcripts.replace(target, Transcript.empty(target.id, target.prompt))
          yield* transcripts.append(target, {
            cursor: "completed",
            sequence: 7,
            type: "execution.completed",
            createdAt: 4,
          })
        }).pipe(provideLayer(layer)),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          const reloaded = yield* transcripts.get(targetId)
          expect(reloaded?.units.find((unit) => unit.key === `turn:${targetId}:user`)).toMatchObject({
            revision: 7,
            executionOutcome: { status: "complete" },
          })
        }).pipe(provideLayer(layer)),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

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

it.effect("persists usage cursors across reopen so redelivered usage never double counts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-usage-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-usage-durable")
      const targetId = Turn.TurnId.make("turn-usage-durable")
      const usage: Transcript.SourceEvent = {
        id: "event-usage-1",
        executionId: "execution:turn-usage-durable",
        cursor: "usage-1",
        sequence: 5,
        type: "model.usage.reported",
        createdAt: 5,
        data: usageData(250_000),
      }
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
          yield* threads.create({ id: threadId, workspace: "/work/usage", title: "Usage", now: 1 })
          yield* turns.createForSubmission({
            id: targetId,
            threadId,
            prompt: "count me",
            executionRoute: Turn.testExecutionRoute(),
            queueCapacity: 128,
            now: 2,
          })
          yield* turns.setStatus(targetId, "completed", undefined, 3)
          const target = yield* turns.get(targetId)
          if (target === undefined) return yield* Effect.die("turn was not stored")
          yield* transcripts.appendAll(target, [usage])
        }).pipe(provideLayer(makeLayer())),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const target = yield* turns.get(targetId)
          if (target === undefined) return yield* Effect.die("turn was not stored")
          const redelivered = yield* transcripts.appendAll(target, [
            usage,
            { cursor: "completed", sequence: 6, type: "execution.completed", createdAt: 6 },
          ])
          expect(redelivered.costUsd).toBeCloseTo(1.25, 10)
          expect(redelivered.usageCursors).toEqual(["execution:turn-usage-durable\u0000event-usage-1"])
          expect(yield* transcripts.globalCostUsd).toBeCloseTo(1.25, 10)
        }).pipe(provideLayer(makeLayer())),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("keyset-paginates a durable subagent tree whose nested units outnumber the page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-nested-page-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-nested-page")
      const targetId = Turn.TurnId.make("turn-nested-page")
      const childId = "turn-nested-page:child:agent"
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      const parent = Transcript.project(targetId, "delegate", [
        {
          cursor: "agent",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: {
            tool_call_id: "agent",
            tool_name: "transfer_to_oracle",
            input: { input: [{ type: "text", text: "Investigate" }] },
          },
        },
        {
          cursor: "spawned",
          sequence: 1,
          type: "child_run.spawned",
          createdAt: 1,
          data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
        },
        { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 2 },
      ])
      const child = Transcript.project(
        childId,
        "",
        Array.from({ length: 8 }, (_, index) => ({
          cursor: `child-tool-${index}`,
          sequence: index,
          type: "tool.call.requested" as const,
          createdAt: index,
          data: { tool_call_id: `child-call-${index}`, tool_name: "read", input: { path: `file-${index}.ts` } },
        })),
      )
      const live = Transcript.withNestedProjections(parent, [{ parentId: `${targetId}:agent`, projection: child }])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id: threadId, workspace: "/work/nested", title: "Nested", now: 1 })
          yield* turns.createForSubmission({
            id: targetId,
            threadId,
            prompt: "delegate",
            executionRoute: Turn.testExecutionRoute(),
            queueCapacity: 128,
            now: 2,
          })
          yield* turns.setStatus(targetId, "completed", undefined, 3)
          const target = yield* turns.get(targetId)
          if (target === undefined) return yield* Effect.die("turn was not stored")
          yield* transcripts.replace(target, live)

          const collected: Array<string> = []
          let before: TranscriptRepository.PageCursor | undefined
          for (let iteration = 0; iteration < live.units.length + 5; iteration += 1) {
            const page = yield* transcripts.page(threadId, { ...(before === undefined ? {} : { before }), limit: 3 })
            collected.push(...page.entries.map((entry) => entry.unit.key))
            if (!page.hasOlder || page.oldestCursor === undefined) break
            before = page.oldestCursor
          }

          expect(new Set(collected).size).toBe(live.units.length)
          expect(collected.length).toBe(live.units.length)
          expect(new Set(collected)).toEqual(new Set(live.units.map((unit) => unit.key)))
        }).pipe(provideLayer(layer)),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
