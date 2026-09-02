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
      redrawTerminal: () => undefined,
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
  return { ...eventRouter, loop, showToast, close: () => setup.renderer.destroy() }
})

describe("approval control failures", () => {
  for (const [action, label] of [
    ["approve", "Approval"],
    ["deny", "Denial"],
  ] as const)
    it.effect(`shows a nonterminal structured error when ${action} fails`, () =>
      Effect.gen(function* () {
        const { dispatch, loop, showToast, close } = yield* router
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
        expect(showToast).not.toHaveBeenCalled()
        expect(loop.model.blocks).toContainEqual({
          _tag: "Error",
          title: `${label} failed`,
          detail: "Authorization is no longer pending",
        })
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

describe("turn failures", () => {
  it.effect("keeps the transcript error and also shows a toast", () =>
    Effect.gen(function* () {
      const { dispatch, loop, showToast, close } = yield* router
      loop.model = { ...loop.model, activeTurnId: "turn", busy: true }
      dispatch({
        _tag: "ExecutionFailed",
        threadId: Thread.ThreadId.make("thread"),
        turnId: Turn.TurnId.make("turn"),
        failure: {
          tag: "TurnFailed",
          message: "Provider rejected credentials",
          category: "authentication",
          retryable: false,
          retry: "none",
          actor: "environment",
        },
      })

      expect(showToast).toHaveBeenCalledWith("Provider rejected credentials", "#e06c75")
      expect(loop.model.blocks).toContainEqual({
        _tag: "Error",
        title: "TurnFailed",
        detail: "Provider rejected credentials",
        category: "authentication",
        retryable: false,
      })
      close()
    }),
  )
})
