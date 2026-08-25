import { describe, expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { createTestRenderer } from "@opentui/core/testing"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Surface } from "@rika/terminal/opentui-surface"
import { initial } from "@rika/terminal/terminal-state"
import { Effect } from "effect"
import { makeEventRouter } from "../../../../src/interactive/process/lifecycle/events"

const router = Effect.gen(function* () {
  const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false }))
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  const showToast = vi.spyOn(surface, "showToast")
  const loop = {
    closed: false,
    model: { ...initial("/workspace", "medium"), currentThreadId: "thread" },
    renderer: {
      surface,
      releaseTerminal: () => undefined,
      suspendTerminal: () => undefined,
      resumeTerminal: () => undefined,
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
  return { ...eventRouter, showToast, close: () => setup.renderer.destroy() }
})

describe("approval control failures", () => {
  for (const [action, label] of [
    ["approve", "Approval"],
    ["deny", "Denial"],
  ] as const)
    it.effect(`shows a nonterminal red toast when ${action} fails`, () =>
      Effect.gen(function* () {
        const { dispatch, showToast, close } = yield* router
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
        close()
      }),
    )

  it.effect("does not surface another thread's approval failure", () =>
    Effect.gen(function* () {
      const { dispatch, showToast, close } = yield* router
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
      close()
    }),
  )
})
