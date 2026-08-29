import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TurnId } from "@rika/product/turn-record"
import * as ExecutionProjection from "../../../src/execution/projection/contract"
import { executeInteractiveCommand } from "../../../src/operation/interactive/command"
import type { InteractiveSession } from "../../../src/operation/interactive/session"

const invocation = <Command>(command: Command) => ({
  commandId: "command",
  turnId: TurnId.make("invocation-turn"),
  command,
})

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
      yield* executeInteractiveCommand(
        session,
        invocation({
          _tag: "ApproveAuthorization",
          turnId: "turn",
          authorizationId: "authorization",
          checkpoint,
        }),
      )
      yield* executeInteractiveCommand(
        session,
        invocation({
          _tag: "DenyAuthorization",
          turnId: "turn",
          authorizationId: "authorization",
          checkpoint,
        }),
      )
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
      yield* executeInteractiveCommand(
        session,
        invocation({
          _tag: "PreviewThread",
          threadId: "thread",
          requestId: 42,
        }),
      )
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
      yield* executeInteractiveCommand(session, invocation({ _tag: "ArchiveThread" }))
      yield* executeInteractiveCommand(session, invocation({ _tag: "ArchiveAndNewThread" }))
      expect(calls).toEqual(["archive", "archive-and-new"])
    }),
  )
})

describe("Interactive Turn identity", () => {
  it.effect("forwards the admitted Turn identity to Turn-creating commands", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      const session = sessionWith({
        submit: (...args) => Effect.sync(() => calls.push(["submit", args[5]])),
        shell: (...args) => Effect.sync(() => calls.push(["shell", args[3]])),
        interruptAndSend: (...args) => Effect.sync(() => calls.push(["interrupt-and-send", args[2]])),
      })
      yield* executeInteractiveCommand(session, invocation({ _tag: "Submit", prompt: "work" }))
      yield* executeInteractiveCommand(session, invocation({ _tag: "Shell", command: "pwd", incognito: false }))
      yield* executeInteractiveCommand(session, invocation({ _tag: "InterruptAndSend", prompt: "new work" }))
      expect(calls).toEqual([
        ["submit", "invocation-turn"],
        ["shell", "invocation-turn"],
        ["interrupt-and-send", "invocation-turn"],
      ])
    }),
  )
})
