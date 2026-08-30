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

it.effect("resends the exact admitted mutation until its authoritative outcome is known", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let version = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", version), String(version)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        const submissions = harness.messages.filter((candidate) => candidate.command._tag === "SubmitPrompt")
        if (submissions.length === 1) {
          version = 1
          socket.close()
          return
        }
        socket.frame({
          _tag: "CommandAccepted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make(String(version)),
          cursor: ThreadEventCursor.make(String(version)),
          result: { _tag: "Applied" },
        })
      })
      const hosted = yield* H.runSession(harness)
      const submitted = yield* hosted.session
        .submit("first", undefined, [], undefined, "submission-1")
        .pipe(Effect.forkScoped)
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* H.reconnect(harness)
      yield* Fiber.join(submitted)
      const commands = harness.messages.filter((message) => message.command._tag === "SubmitPrompt")
      expect(commands).toHaveLength(2)
      expect(commands[0]!.command).toEqual(commands[1]!.command)
      expect(commands[0]!.requestId).not.toBe(commands[1]!.requestId)
      expect(commands[0]!.command).not.toHaveProperty("attachments")
      expect(version).toBe(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("retries the exact mutation when the server reports a transient application failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        const submissions = harness.messages.filter((candidate) => candidate.command._tag === "SubmitPrompt")
        socket.frame(
          submissions.length === 1
            ? {
                _tag: "CommandRejected",
                requestId: message.requestId,
                commandId: message.command.commandId,
                threadId: message.command.threadId,
                reason: "unavailable",
                currentThreadVersion: ThreadVersion.make("1"),
                currentCursor: ThreadEventCursor.make("0"),
                message: "application interrupted",
                details: {},
              }
            : {
                _tag: "CommandAccepted",
                requestId: message.requestId,
                commandId: message.command.commandId,
                threadId: message.command.threadId,
                threadVersion: ThreadVersion.make("1"),
                cursor: ThreadEventCursor.make("0"),
                result: { _tag: "PromptAdmitted", status: "queued" },
              },
        )
      })
      const hosted = yield* H.runSession(harness)
      const submitted = yield* hosted.session
        .submit("retry transient", undefined, [], undefined, "submission-transient")
        .pipe(Effect.forkScoped)
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "unknown-operation")
      yield* TestClock.adjust("250 millis")
      yield* Fiber.join(submitted)
      const commands = harness.messages.filter((message) => message.command._tag === "SubmitPrompt")
      expect(commands).toHaveLength(2)
      expect(commands[0]!.command).toEqual(commands[1]!.command)
      expect(commands[0]!.requestId).not.toBe(commands[1]!.requestId)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("targets the pending submission identity when cancellation happens before a Turn exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pendingSubmit: H.Message | undefined
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
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
            _tag: "CommandAccepted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
            cursor: ThreadEventCursor.make("0"),
            result: { _tag: "Applied" },
          })
      })
      const hosted = yield* H.runSession(harness)
      const submitted = yield* hosted.session
        .submit("cancel before admission", undefined, [], undefined, "submission-before-turn")
        .pipe(Effect.forkScoped)
      yield* H.eventually(() => pendingSubmit !== undefined)
      const cancellationFiber = yield* hosted.session
        .cancel({ submissionId: "submission-before-turn", threadId: "thread-1" })
        .pipe(Effect.forkScoped)
      yield* Fiber.join(cancellationFiber)
      const cancellation = harness.messages.find((message) => message.command._tag === "Cancel")
      if (pendingSubmit === undefined || pendingSubmit.command._tag !== "SubmitPrompt")
        return yield* Effect.die("Submission was not captured")
      const durableSubmitCommandId = pendingSubmit.command.commandId
      expect(pendingSubmit.command).toMatchObject({
        _tag: "SubmitPrompt",
        submissionId: "submission-before-turn",
      })
      expect(durableSubmitCommandId).not.toBe("submission-before-turn")
      expect(cancellation?.command).toMatchObject({
        _tag: "Cancel",
        target: { _tag: "Command", commandId: durableSubmitCommandId },
      })
      yield* Fiber.join(submitted)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("forgets submission cancellation rendezvous after admission or rejection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let version = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        version += 1
        socket.frame({
          _tag: "CommandAdmitted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make(String(version)),
        })
      })
      const hosted = yield* H.runSession(harness)
      yield* hosted.session.submit("admitted", undefined, [], undefined, "submission-admitted")
      harness.sockets[0]!.frame({
        _tag: "ThreadEvent",
        event: {
          threadId: HostedThreadId.make("thread-1"),
          sequence: Sequence.make("1"),
          cursor: ThreadEventCursor.make("1"),
          threadVersion: ThreadVersion.make("1"),
          event: {
            _tag: "SubmissionAdmitted",
            threadId: Thread.ThreadId.make("thread-1"),
            turnId: Turn.TurnId.make("turn-1"),
            status: "active",
            submissionId: "submission-admitted",
          },
          createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
        },
      })
      yield* H.eventually(() =>
        harness.messages.some(
          (message) => message.command._tag === "AcknowledgeCursor" && String(message.command.cursor) === "1",
        ),
      )
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-admitted", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })

      yield* hosted.session.submit("rejected", undefined, [], undefined, "submission-rejected")
      harness.sockets[0]!.frame({
        _tag: "ThreadEvent",
        event: {
          threadId: HostedThreadId.make("thread-1"),
          sequence: Sequence.make("2"),
          cursor: ThreadEventCursor.make("2"),
          threadVersion: ThreadVersion.make("2"),
          event: {
            _tag: "SubmissionRejected",
            message: "rejected",
            submissionId: "submission-rejected",
          },
          createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
        },
      })
      yield* H.eventually(() =>
        harness.messages.some(
          (message) => message.command._tag === "AcknowledgeCursor" && String(message.command.cursor) === "2",
        ),
      )
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-rejected", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("forgets submission cancellation rendezvous after a definitive command rejection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        socket.frame({
          _tag: "CommandRejected",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          reason: "forbidden",
          currentCursor: ThreadEventCursor.make("0"),
          message: "Submission rejected",
          details: {},
        })
      })
      const hosted = yield* H.runSession(harness)
      expect(
        yield* Effect.result(
          hosted.session.submit("rejected", undefined, [], undefined, "submission-command-rejected"),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect(
        yield* Effect.result(
          hosted.session.cancel({ submissionId: "submission-command-rejected", threadId: "thread-1" }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("retires a definitive rejection before cancellation can observe its command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        socket.frame({
          _tag: "CommandRejected",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          reason: "forbidden",
          currentCursor: ThreadEventCursor.make("0"),
          message: "Submission rejected",
          details: {},
        })
      })
      const hosted = yield* H.runSession(harness)
      const submitted = yield* hosted.session
        .submit("rejected", undefined, [], undefined, "submission-rejection-race")
        .pipe(Effect.result, Effect.forkScoped)
      yield* H.eventually(() => harness.messages.some((message) => message.command._tag === "SubmitPrompt"))
      yield* Effect.yieldNow
      expect(
        yield* Effect.result(
          hosted.session.cancel({ submissionId: "submission-rejection-race", threadId: "thread-1" }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect((yield* Fiber.join(submitted))._tag).toBe("Failure")
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)
      yield* hosted.session.quit
    }),
  ),
)
