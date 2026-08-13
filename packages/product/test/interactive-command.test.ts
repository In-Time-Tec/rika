import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { executeInteractiveCommand } from "../src/operation/interactive/command"
import type { InteractiveSession } from "../src/operation/interactive/session"

describe("Interactive authorization commands", () => {
  it.effect("dispatches only the public turn and authorization identities", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      const session = {
        approveAuthorization: (turnId: string, authorizationId: string) =>
          Effect.sync(() => calls.push(["approve", turnId, authorizationId])),
        denyAuthorization: (turnId: string, authorizationId: string) =>
          Effect.sync(() => calls.push(["deny", turnId, authorizationId])),
      } as unknown as InteractiveSession
      yield* executeInteractiveCommand(session, {
        _tag: "ApproveAuthorization",
        turnId: "turn",
        authorizationId: "authorization",
      })
      yield* executeInteractiveCommand(session, {
        _tag: "DenyAuthorization",
        turnId: "turn",
        authorizationId: "authorization",
      })
      expect(calls).toEqual([
        ["approve", "turn", "authorization"],
        ["deny", "turn", "authorization"],
      ])
    }),
  )
})

describe("Interactive preview commands", () => {
  it.effect("forwards the preview request identity", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      const session = {
        previewThread: (threadId: string, requestId: number) => Effect.sync(() => calls.push([threadId, requestId])),
      } as unknown as InteractiveSession
      yield* executeInteractiveCommand(session, {
        _tag: "PreviewThread",
        threadId: "thread",
        requestId: 42,
      })
      expect(calls).toEqual([["thread", 42]])
    }),
  )
})
