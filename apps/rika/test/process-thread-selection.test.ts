import { describe, expect, it } from "vitest"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { initial } from "@rika/terminal/terminal-state"
import { update } from "@rika/terminal/terminal-state-reducer"
import { makeEventRouter } from "../src/interactive/process/process-events"

const snapshot = (threadId: string) => ({
  thread: {
    id: Thread.ThreadId.make(threadId),
    workspace: "workspace",
    title: threadId,
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" as const },
    createdAt: 1,
    updatedAt: 1,
  },
  revision: 0,
  source: { projectionVersion: ExecutionProjection.projectionVersion },
  turns: [],
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})

describe("created Thread selection", () => {
  it("accepts the unknown created Thread snapshot and admits its immediate submission", () => {
    const submitted = update(
      {
        ...initial("/workspace", "medium"),
        currentThreadId: "runner-thread",
        input: "run in the Orb",
        cursor: "run in the Orb".length,
      },
      { _tag: "Submitted", submissionId: "submission-1" },
    )
    const loop = {
      closed: false,
      model: submitted,
      threadView: undefined,
      modelPreview: undefined,
      requestedThreadId: "runner-thread",
      newThreadSelectionGeneration: 2,
      renderer: undefined,
      submittedSinceIdle: true,
    }
    const { dispatch } = makeEventRouter({
      loop,
      render: () => undefined,
      refreshTerminalTitle: () => undefined,
      requestSelectionResync: () => undefined,
    } as never)

    dispatch({ _tag: "ThreadViewSnapshot", snapshot: snapshot("orb-thread") })
    dispatch({
      _tag: "SubmissionAdmitted",
      threadId: Thread.ThreadId.make("orb-thread"),
      turnId: Turn.TurnId.make("turn-1"),
      status: "active",
      submissionId: "submission-1",
    })

    expect(loop.model.currentThreadId).toBe("orb-thread")
    expect(loop.requestedThreadId).toBe("orb-thread")
    expect(loop.newThreadSelectionGeneration).toBeUndefined()
    expect(loop.model.input).toBe("")
    expect(loop.model.submittedDrafts).toMatchObject([{ submissionId: "submission-1", turnId: "turn-1" }])
  })
})
