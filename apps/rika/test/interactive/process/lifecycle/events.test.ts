import { describe, expect, it, vi } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { initial } from "@rika/terminal/terminal-state"
import { makeEventRouter } from "../../../../src/interactive/process/lifecycle/events"

const router = () => {
  const showToast = vi.fn()
  const loop = {
    closed: false,
    model: { ...initial("/workspace", "medium"), currentThreadId: "thread" },
    renderer: {
      surface: { showToast, showCtrlCMenu: () => undefined, update: () => undefined },
    },
    submittedSinceIdle: false,
    threadView: undefined,
    modelPreview: undefined,
    requestedThreadId: undefined,
    ctrlCMenuVisible: false,
  }
  const eventRouter = makeEventRouter({
    loop,
    render: () => undefined,
    refreshTerminalTitle: () => undefined,
    requestSelectionResync: () => undefined,
  })
  return { ...eventRouter, showToast }
}

describe("approval control failures", () => {
  it.each([
    ["approve", "Approval"],
    ["deny", "Denial"],
  ] as const)("shows a nonterminal red toast when %s fails", (action, label) => {
    const { dispatch, showToast } = router()
    dispatch({
      _tag: "ExecutionControlFailed",
      threadId: Thread.ThreadId.make("thread"),
      turnId: Turn.TurnId.make("turn"),
      action,
      failure: {
        tag: "ApprovalResponseFailure",
        message: "Authorization is no longer pending",
        category: "operation",
        retryable: false,
        retry: "none",
        actor: "user",
      },
    })
    expect(showToast).toHaveBeenCalledWith(`${label} failed: Authorization is no longer pending`, "#e06c75")
  })

  it("does not surface another thread's approval failure", () => {
    const { dispatch, showToast } = router()
    dispatch({
      _tag: "ExecutionControlFailed",
      threadId: Thread.ThreadId.make("other-thread"),
      turnId: Turn.TurnId.make("turn"),
      action: "approve",
      failure: {
        tag: "ApprovalResponseFailure",
        message: "Authorization is no longer pending",
        category: "operation",
        retryable: false,
        retry: "none",
        actor: "user",
      },
    })
    expect(showToast).not.toHaveBeenCalled()
  })
})
