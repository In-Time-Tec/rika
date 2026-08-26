import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ExecutionProjection from "../../../src/execution/projection/contract"
import { executeInteractiveCommand } from "../../../src/operation/interactive/command"
import type { InteractiveSession } from "../../../src/operation/interactive/session"

const sessionWith = (overrides: Partial<InteractiveSession>): InteractiveSession => ({
  events: () => Effect.void,
  currentView: () => undefined,
  projectionCheckpoint: () => undefined,
  submit: () => Effect.void,
  shell: () => Effect.void,
  editQueued: () => Effect.void,
  dequeue: () => Effect.void,
  steerQueued: () => Effect.void,
  steer: () => Effect.void,
  approveAuthorization: () => Effect.void,
  denyAuthorization: () => Effect.void,
  interruptAndSend: () => Effect.void,
  cancel: Effect.void,
  quit: Effect.void,
  newThread: Effect.void,
  archiveThread: Effect.void,
  archiveAndNewThread: Effect.void,
  selectThread: () => Effect.void,
  readQueue: () => Effect.void,
  previewThread: () => Effect.void,
  reopenThread: Effect.void,
  ...overrides,
})

describe("Interactive authorization commands", () => {
  it.effect("dispatches only the public turn and authorization identities", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      const session = sessionWith({
        approveAuthorization: (turnId: string, authorizationId: string, checkpoint?: ExecutionProjection.Checkpoint) =>
          Effect.sync(() => calls.push(["approve", turnId, authorizationId, checkpoint])),
        denyAuthorization: (turnId: string, authorizationId: string, checkpoint?: ExecutionProjection.Checkpoint) =>
          Effect.sync(() => calls.push(["deny", turnId, authorizationId, checkpoint])),
      })
      const checkpoint = { version: ExecutionProjection.projectionVersion, cursor: "cursor", state: "{}" }
      yield* executeInteractiveCommand(session, {
        _tag: "ApproveAuthorization",
        turnId: "turn",
        authorizationId: "authorization",
        checkpoint,
      })
      yield* executeInteractiveCommand(session, {
        _tag: "DenyAuthorization",
        turnId: "turn",
        authorizationId: "authorization",
        checkpoint,
      })
      expect(calls).toEqual([
        ["approve", "turn", "authorization", checkpoint],
        ["deny", "turn", "authorization", checkpoint],
      ])
    }),
  )
})

describe("Interactive preview commands", () => {
  it.effect("forwards the preview request identity", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      const session = sessionWith({
        previewThread: (threadId: string, requestId: number) => Effect.sync(() => calls.push([threadId, requestId])),
      })
      yield* executeInteractiveCommand(session, {
        _tag: "PreviewThread",
        threadId: "thread",
        requestId: 42,
      })
      expect(calls).toEqual([["thread", 42]])
    }),
  )
})

describe("Interactive thread lifecycle commands", () => {
  it.effect("dispatches archive and archive-and-new commands", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const session = sessionWith({
        archiveThread: Effect.sync(() => calls.push("archive")),
        archiveAndNewThread: Effect.sync(() => calls.push("archive-and-new")),
      })
      yield* executeInteractiveCommand(session, { _tag: "ArchiveThread" })
      yield* executeInteractiveCommand(session, { _tag: "ArchiveAndNewThread" })
      expect(calls).toEqual(["archive", "archive-and-new"])
    }),
  )
})
