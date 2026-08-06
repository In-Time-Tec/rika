import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { recordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import { initialTranscriptWindow } from "../src/operation/interactive/transcript-window"
import { makeSelectionState } from "../src/operation/interactive/interactive-thread-selection"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-shell-window"),
  workspace: "/work",
  title: "shell",
  pinned: false,
  archived: false,
  labels: [],
  createdAt: 1,
  updatedAt: 1,
}
const turn = {
  _tag: "RecordedShell" as const,
  id: Turn.TurnId.make("shell-window"),
  threadId: thread.id,
  prompt: "$ echo done",
  command: "echo done",
  status: "completed" as const,
  result: { text: "done", truncated: false, exitCode: 0 },
  author: { _tag: "Human" as const },
  lineage: { _tag: "Original" as const },
  createdAt: 2,
  updatedAt: 3,
}

it.effect("derives a terminal recorded shell from its authoritative Turn instead of a stale running read model", () =>
  Effect.gen(function* () {
    const stale = recordedShellProjection({ id: turn.id, command: turn.command, status: "running" })
    const window = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      turns: {
        page: () =>
          Effect.succeed({ turns: [turn], hasOlder: false, oldestCursor: undefined, newestCursor: undefined }),
      },
      transcripts: {
        get: () =>
          Effect.succeed({
            turn,
            units: stale.units,
            revision: stale.revision,
            checkpointGeneration: 0,
            projectionVersion: 1,
            state: {
              status: "running",
              usage: ExecutionProjection.emptyUsageState(),
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          }),
        usage: () => Effect.succeed({ usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true } }),
      },
      maxTurns: 10,
      maxEntries: 10,
      fail: (message) => Effect.die(message),
    })
    expect(window.entries).toHaveLength(1)
    expect(window.entries[0]?.unit.content).toMatchObject({ block: { status: "complete", output: "done" } })
  }),
)
