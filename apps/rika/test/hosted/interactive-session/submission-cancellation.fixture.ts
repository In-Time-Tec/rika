import { expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  Sequence,
  ThreadEventCursor,
  ThreadVersion,
  Timestamp,
  ThreadId as HostedThreadId,
} from "@rika/product/hosted-model"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as H from "./harness"

it.effect("releases a submission identity interrupted before any connection can send it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        socket.frame({
          _tag: "CommandAdmitted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make("1"),
        })
      })
      const hosted = yield* H.runSession(harness)
      harness.sockets[0]!.close()
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      const abandoned = yield* hosted.session
        .submit("abandoned", undefined, [], undefined, "submission-before-send")
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(abandoned)
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-before-send", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })
      yield* H.reconnect(harness)
      yield* hosted.session.submit("retry", undefined, [], undefined, "submission-before-send")
      expect(harness.messages.filter((message) => message.command._tag === "SubmitPrompt")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("rejects a duplicate in-flight submission identity without sending another command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pending: H.Message | undefined
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt") pending = message
      })
      const hosted = yield* H.runSession(harness)
      const first = yield* hosted.session
        .submit("first", undefined, [], undefined, "submission-duplicate")
        .pipe(Effect.forkScoped)
      yield* H.eventually(() => pending !== undefined)
      expect(
        yield* Effect.result(hosted.session.submit("duplicate", undefined, [], undefined, "submission-duplicate")),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "SubmitPrompt")).toHaveLength(1)
      if (pending === undefined || pending.command._tag !== "SubmitPrompt")
        return yield* Effect.die("Submission was not captured")
      harness.sockets[0]!.frame({
        _tag: "CommandAdmitted",
        requestId: pending.requestId,
        commandId: pending.command.commandId,
        threadId: pending.command.threadId,
        threadVersion: ThreadVersion.make("1"),
      })
      yield* Fiber.join(first)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps pending submission cancellation across an unrelated newer reattachment snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let threadOneAttachments = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          const threadId = String(message.command.threadId)
          if (threadId === "thread-1") threadOneAttachments += 1
          socket.frame(
            H.fixtures.attached(
              message,
              H.fixtures.snapshot(threadId, threadId === "thread-1" && threadOneAttachments === 2 ? 1 : 0),
              threadId === "thread-1" && threadOneAttachments === 2 ? "1" : "0",
            ),
          )
          return
        }
        if (message.command._tag === "SubmitPrompt")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("2"),
          })
      })
      const hosted = yield* H.runSession(harness)
      yield* hosted.session.submit("pending", undefined, [], undefined, "submission-compacted")
      yield* hosted.session.selectThread("thread-2")
      yield* hosted.session.selectThread("thread-1")
      yield* hosted.session.cancel({ submissionId: "submission-compacted", threadId: "thread-1" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps pending cancellation when a reconnect attachment is rejected as stale", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachments = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          attachments += 1
          if (attachments === 1) {
            socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
            return
          }
          if (attachments === 2) {
            socket.frame({
              ...H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0), "1"),
              baseCursor: ThreadEventCursor.make("0"),
              checkpoint: {
                threadVersion: ThreadVersion.make("0"),
                cursor: ThreadEventCursor.make("0"),
                snapshot: H.fixtures.snapshot("thread-1", 0),
              },
              events: [
                {
                  threadId: HostedThreadId.make("thread-1"),
                  sequence: Sequence.make("1"),
                  cursor: ThreadEventCursor.make("1"),
                  threadVersion: ThreadVersion.make("1"),
                  event: {
                    _tag: "SubmissionAdmitted",
                    threadId: Thread.ThreadId.make("thread-1"),
                    turnId: Turn.TurnId.make("turn-stale"),
                    status: "active",
                    submissionId: "submission-stale-attachment",
                  },
                  createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
                },
              ],
            })
            return
          }
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 2), "2"))
          return
        }
        if (message.command._tag === "SubmitPrompt")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("3"),
          })
      })
      const hosted = yield* H.runSession(harness)
      yield* hosted.session.submit("pending", undefined, [], undefined, "submission-stale-attachment")
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: H.fixtures.event("thread-1", "1") })
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: H.fixtures.event("thread-1", "2") })
      yield* H.eventually(() => hosted.session.currentView()?.thread.updatedAt === 2)
      harness.sockets[0]!.close()
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* H.reconnect(harness)
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* TestClock.adjust("1 second")
      yield* H.eventually(() => harness.sockets.length === 3)
      yield* hosted.session.cancel({ submissionId: "submission-stale-attachment", threadId: "thread-1" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps pending submission cancellation scoped to its Thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pendingSubmit: H.Message | undefined
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot(String(message.command.threadId), 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt") {
          pendingSubmit = message
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
          return
        }
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("2"),
          })
      })
      const hosted = yield* H.runSession(harness)
      yield* hosted.session.submit("pending on first Thread", undefined, [], undefined, "submission-first")
      yield* hosted.session.selectThread("thread-2")
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-first", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)

      yield* hosted.session.selectThread("thread-1")
      yield* hosted.session.cancel({ submissionId: "submission-first", threadId: "thread-1" })
      const cancellation = harness.messages.find((message) => message.command._tag === "Cancel")
      if (pendingSubmit === undefined || pendingSubmit.command._tag !== "SubmitPrompt")
        return yield* Effect.die("Submission was not captured")
      expect(cancellation?.command).toMatchObject({
        _tag: "Cancel",
        threadId: "thread-1",
        target: { _tag: "Command", commandId: pendingSubmit.command.commandId },
      })
      yield* hosted.session.quit
    }),
  ),
)
