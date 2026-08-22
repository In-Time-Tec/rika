// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import {
  ChangedDraft,
  ChangedThreadId,
  ClickedConnect,
  ConnectedThread,
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

    const [connected] = update(connecting, ConnectedThread({ threadId: "thread-1" }))
    const [withFrame] = update(
      connected,
      GotThreadFrame({ frame: { protocolVersion: 1, payload: { _tag: "ThreadSnapshot", threadVersion: "7" } } }),
    )
    expect(withFrame.threadVersion).toBe("7")
    expect(withFrame.frames).toHaveLength(1)

    const [drafted] = update(withFrame, ChangedDraft({ value: "continue the refactor" }))
    const [submitted, submitCommands] = update(drafted, SubmittedPrompt())
    expect(submitted.draft).toBe("")
    expect(submitCommands.map(({ name }) => name)).toEqual(["SubmitThreadPrompt"])
    expect(submitCommands[0]?.args).toEqual({
      threadId: "thread-1",
      threadVersion: "7",
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
})
