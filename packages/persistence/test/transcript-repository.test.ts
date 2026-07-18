import * as Transcript from "@rika/transcript"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Thread from "../src/thread-schema"
import * as TranscriptRepository from "../src/transcript-repository"
import * as Turn from "../src/turn-schema"

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
