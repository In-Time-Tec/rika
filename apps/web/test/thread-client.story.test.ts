// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import {
  ChangedDraft,
  ChangedThreadId,
  ClickedConnect,
  ConnectedThread,
  FailedThreadConnection,
  GotThreadFrame,
  SubmittedPrompt,
  init,
  update,
} from "../src/client/main"

describe("FoldKit Thread client story", () => {
  it("connects, receives a durable cursor, and submits through one modeled command path", () => {
    const [initial] = init()
    const [withThread] = update(initial, ChangedThreadId({ value: "thread-1" }))
    const [connecting, connectCommands] = update(withThread, ClickedConnect())
    expect(connecting.connection).toBe("connecting")
    expect(connectCommands.map(({ name }) => name)).toEqual(["ConnectThread"])

    const [connected] = update(
      connecting,
      ConnectedThread({
        epoch: 1,
        threadId: "thread-1",
        frame: { protocolVersion: 1, payload: { _tag: "ThreadAttached", threadId: "thread-1", threadVersion: "6" } },
      }),
    )
    expect(connected).toMatchObject({ attachedThreadId: "thread-1", connectionEpoch: 1, threadVersion: "6" })
    const [withFrame] = update(
      connected,
      GotThreadFrame({ frame: { protocolVersion: 1, payload: { _tag: "ThreadSnapshot", threadVersion: "7" } } }),
    )
    expect(withFrame.threadVersion).toBe("7")
    expect(withFrame.frames).toHaveLength(2)

    const [withEvent] = update(
      withFrame,
      GotThreadFrame({
        frame: {
          protocolVersion: 1,
          payload: {
            _tag: "ThreadEvent",
            event: { threadId: "thread-1", threadVersion: "8" },
          },
        },
      }),
    )
    expect(withEvent.threadVersion).toBe("8")
    const [afterStaleFrame] = update(
      withEvent,
      GotThreadFrame({
        frame: {
          protocolVersion: 1,
          payload: { _tag: "PortalOpened", threadId: "thread-old", threadVersion: "99", url: "https://stale" },
        },
      }),
    )
    expect(afterStaleFrame).toEqual(withEvent)

    const [drafted] = update(withEvent, ChangedDraft({ value: "continue the refactor" }))
    const [submitted, submitCommands] = update(drafted, SubmittedPrompt())
    expect(submitted.draft).toBe("")
    expect(submitCommands.map(({ name }) => name)).toEqual(["SubmitThreadPrompt"])
    expect(submitCommands[0]?.args).toEqual({
      threadId: "thread-1",
      threadVersion: "8",
      text: "continue the refactor",
    })
  })

  it("keeps invalid connection and submission attempts inside explicit states", () => {
    const [initial] = init()
    const [rejected, commands] = update(initial, ClickedConnect())
    expect(rejected).toMatchObject({ connection: "failed", error: "Enter a Thread ID" })
    expect(commands).toEqual([])
    expect(update(initial, SubmittedPrompt())).toEqual([initial, []])
  })

  it("keeps editable and committed identity separate and ignores superseded connection results", () => {
    const [initial] = init()
    const [withA] = update(initial, ChangedThreadId({ value: "thread-a" }))
    const [connectingA] = update(withA, ClickedConnect())
    const [withB] = update(connectingA, ChangedThreadId({ value: "thread-b" }))
    const [connectingB] = update(withB, ClickedConnect())
    const [connectedB] = update(
      connectingB,
      ConnectedThread({
        epoch: 2,
        threadId: "thread-b",
        frame: { protocolVersion: 1, payload: { _tag: "ThreadAttached", threadId: "thread-b", threadVersion: "2" } },
      }),
    )
    const [afterLateFailure] = update(connectedB, FailedThreadConnection({ epoch: 1, message: "superseded A failed" }))
    expect(afterLateFailure).toEqual(connectedB)

    const [editingC] = update(connectedB, ChangedThreadId({ value: "thread-c" }))
    const [afterBFrame] = update(
      editingC,
      GotThreadFrame({
        frame: {
          protocolVersion: 1,
          payload: { _tag: "ThreadSnapshot", threadId: "thread-b", threadVersion: "3" },
        },
      }),
    )
    expect(afterBFrame).toMatchObject({ threadId: "thread-c", attachedThreadId: "thread-b", threadVersion: "3" })

    const [connectingC] = update(editingC, ClickedConnect())
    expect(connectingC).toMatchObject({ connection: "connecting", attachedThreadId: "thread-b", threadVersion: "2" })
    const [duringCandidate] = update(
      connectingC,
      GotThreadFrame({
        frame: { protocolVersion: 1, payload: { _tag: "ThreadSnapshot", threadId: "thread-b", threadVersion: "4" } },
      }),
    )
    expect(duringCandidate).toMatchObject({ connection: "connecting", attachedThreadId: "thread-b", threadVersion: "4" })
    const [restored] = update(duringCandidate, FailedThreadConnection({ epoch: 3, message: "C mismatch" }))
    expect(restored).toMatchObject({ connection: "connected", attachedThreadId: "thread-b", error: "C mismatch" })
    const [drafted] = update(restored, ChangedDraft({ value: "still A" }))
    const [, commands] = update(drafted, SubmittedPrompt())
    expect(commands[0]?.args).toMatchObject({ threadId: "thread-b", threadVersion: "4" })

    const [foreign] = update(
      restored,
      GotThreadFrame({
        frame: { protocolVersion: 1, payload: { _tag: "ThreadSnapshot", threadId: "thread-c", threadVersion: "99" } },
      }),
    )
    expect(foreign).toEqual(restored)
  })

  it("retains selected identity while unexpected-close recovery is active or has failed", () => {
    const [initial] = init()
    const selected = {
      ...initial,
      connection: "connected" as const,
      threadId: "thread-a",
      attachedThreadId: "thread-a",
      threadVersion: "8",
    }
    const [recovering] = update(
      selected,
      GotThreadFrame({ frame: { protocolVersion: 1, payload: { _tag: "ClientReconnecting", threadId: "thread-a" } } }),
    )
    expect(recovering).toMatchObject({ connection: "connecting", attachedThreadId: "thread-a", threadVersion: "8" })
    const [failed] = update(
      recovering,
      GotThreadFrame({ frame: { protocolVersion: 1, payload: { _tag: "ClientReconnectFailed", threadId: "thread-a" } } }),
    )
    expect(failed).toMatchObject({ connection: "failed", attachedThreadId: "thread-a", threadVersion: "8" })
  })
})
