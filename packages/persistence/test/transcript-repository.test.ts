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
        {
          cursor: "resumed-2",
          sequence: 2,
          type: "model.output.completed",
          createdAt: 2,
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
})
