import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { CommandId, ThreadEventCursor, ThreadVersion, ThreadId as HostedThreadId } from "@rika/product/hosted-model"
import * as H from "./harness"

it.effect("rejects a mutation response with another durable command identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: CommandId.make("another-command"),
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
      })
      const hosted = yield* H.runSession(harness)
      const result = yield* Effect.result(
        hosted.session.submit("wrong response", undefined, [], undefined, "submission-wrong-response"),
      )
      expect(String(result)).toContain("response command identity")
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps UI submission identity separate from durable command identity across reopened sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const durableIds: Array<string> = []
      const run = Effect.fn("HostedInteractiveSessionTest.reopen")(function* () {
        const harness = H.makeHarness((socket, message) => {
          if (message.command._tag === "AttachThread") {
            socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", 0)))
            return
          }
          if (message.command._tag !== "SubmitPrompt") return
          durableIds.push(message.command.commandId)
          expect(message.command.submissionId).toBe("submission-1")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
        })
        const hosted = yield* H.runSession(harness)
        yield* hosted.session.submit("reopened", undefined, [], undefined, "submission-1")
        yield* hosted.session.quit
      })
      yield* run()
      yield* run()
      expect(durableIds).toHaveLength(2)
      expect(durableIds[0]).not.toBe(durableIds[1])
      expect(durableIds.every((id) => id.startsWith("submit:"))).toBe(true)
    }),
  ),
)

it.effect("ignores stale full snapshots and accepts a newer materialization at the same cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const hosted = yield* H.runSession(harness)
      const socket = harness.sockets[0]!
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("2"),
        cursor: ThreadEventCursor.make("2"),
        snapshot: H.fixtures.snapshot("thread-1", 2),
      })
      yield* H.eventually(() => hosted.session.currentView()?.thread.updatedAt === 2)
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("3"),
        cursor: ThreadEventCursor.make("1"),
        snapshot: H.fixtures.snapshot("thread-1", 9),
      })
      yield* Effect.yieldNow
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(2)
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("3"),
        cursor: ThreadEventCursor.make("2"),
        snapshot: H.fixtures.snapshot("thread-1", 3),
      })
      yield* H.eventually(() => hosted.session.currentView()?.thread.updatedAt === 3)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("rejects a full snapshot whose Thread version regresses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const hosted = yield* H.runSession(harness)
      const socket = harness.sockets[0]!
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("2"),
        cursor: ThreadEventCursor.make("2"),
        snapshot: H.fixtures.snapshot("thread-1", 2),
      })
      yield* H.eventually(() => hosted.session.currentView()?.thread.updatedAt === 2)
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("1"),
        cursor: ThreadEventCursor.make("3"),
        snapshot: H.fixtures.snapshot("thread-1", 3),
      })
      yield* TestClock.adjust("250 millis")
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(2)
      yield* hosted.session.quit
    }),
  ),
)
