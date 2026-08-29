import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { maximumTranscriptPayloadBytes } from "../../../../src/thread/transcript/bounds"
import { initialTranscriptWindow } from "../../../../src/operation/interactive/view/transcript-window"
import { makeSelectionState } from "../../../../src/operation/interactive/view/selection"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-window"),
  workspace: "/work",
  title: "window",
  pinned: false,
  archived: false,
  labels: [],
  createdAt: 1,
  updatedAt: 1,
}

it.effect("loads one fixed transcript page with bounded serialized size and truthful boundaries", () =>
  Effect.gen(function* () {
    let reads = 0
    const usage = { usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true } }
    const oldestCursor = { createdAt: 10, turnId: TurnId.make("turn-10"), orderKey: "00010" }
    const newestCursor = { createdAt: 20, turnId: TurnId.make("turn-20"), orderKey: "00020" }
    const entries = Array.from({ length: 120 }, (_, index) => {
      const id = TurnId.make(`turn-${index}`)
      const key = `assistant:${index}`
      return {
        turn: {
          _tag: "RecordedShell" as const,
          id,
          threadId: thread.id,
          prompt: `$ echo ${index}`,
          command: `echo ${index}`,
          status: "completed" as const,
          result: { text: "x".repeat(1_024), truncated: false, exitCode: 0 },
          author: { _tag: "Human" as const },
          lineage: { _tag: "Original" as const },
          createdAt: index,
          updatedAt: index,
        },
        unit: {
          key,
          turnId: id,
          order: [{ sequence: 0, part: 0, key }],
          revision: 0,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: "x".repeat(1_024) },
        },
        projectionRevision: 0,
        projectionModelPhase: -1,
        projectionState: {
          status: "completed" as const,
          usage: ExecutionProjection.emptyUsageState(),
          steering: { steeringMessages: 0, followUpMessages: 0 },
        },
      }
    })
    const window = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      transcripts: {
        page: (_threadId, options) => {
          reads += 1
          expect(options).toEqual({ limit: 120, projectionVersion: ExecutionProjection.projectionVersion })
          return Effect.succeed({
            entries,
            hasOlder: true,
            hasNewer: false,
            oldestCursor,
            newestCursor,
            usage,
          })
        },
      },
      encodeJson,
      fail: (message) => Effect.die(message),
    })
    expect(reads).toBe(1)
    expect(window.entries).toHaveLength(120)
    expect(window.hasOlder).toBe(true)
    expect(window.hasNewer).toBe(false)
    expect(window.oldestCursor).toEqual(oldestCursor)
    expect(window.usage).toEqual(usage)
    expect(new TextEncoder().encode(encodeJson(window)).byteLength).toBeLessThan(maximumTranscriptPayloadBytes)
  }),
)
