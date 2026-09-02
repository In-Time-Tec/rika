import { expect, it } from "@effect/vitest"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  Sequence,
  ThreadEventCursor,
  ThreadVersion,
  ThreadId as HostedThreadId,
  Timestamp,
} from "@rika/product/hosted-model"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as H from "./harness"

it.effect("stops instead of reconnecting after a terminal protocol failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const hosted = yield* H.runSession(harness)
      harness.sockets[0]!.invalidFrame()
      const failure = yield* Effect.flip(Fiber.join(hosted.eventFiber))
      expect(failure).toMatchObject({ operation: "InteractiveSession.events" })
      expect(hosted.states.at(-1)).toMatchObject({ connectivity: "disconnected", errorMessage: failure.message })
      expect(failure.message).not.toBe("")
      yield* TestClock.adjust("1 minute")
      expect(harness.sockets).toHaveLength(1)
    }),
  ),
)

it.effect("does not poll AttachThread while an idle WebSocket remains connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const hosted = yield* H.runSession(harness)
      expect(harness.messages.filter((message) => message.command._tag === "AttachThread")).toHaveLength(1)
      for (let advance = 0; advance < 4; advance += 1) yield* TestClock.adjust("500 millis")
      expect(harness.messages.filter((message) => message.command._tag === "AttachThread")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("uses server workspace readiness for fresh, hot, and cold Orb prompts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const readiness = ["fresh", "hot", "cold"] as const
      let submissions = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(
            H.fixtures.attached(
              message,
              H.fixtures.snapshot("thread-1", 0, "orb", {
                _tag: "OrbWorkspace",
                state: "ready",
                readiness: "hot",
                generation: "1",
              }),
            ),
          )
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        const current = readiness[submissions]!
        submissions += 1
        socket.frame({
          _tag: "CommandAdmitted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make(String(submissions)),
          workspace: {
            _tag: "OrbWorkspace",
            state: current === "hot" ? "ready" : "unassigned",
            readiness: current,
            generation: String(submissions),
          },
        })
      })
      const hosted = yield* H.runSession(harness)
      const publishAdmissionEvent = (cursor: string, event: InteractiveEvent) =>
        harness.sockets[0]!.frame({
          _tag: "ThreadEvent",
          event: {
            threadId: HostedThreadId.make("thread-1"),
            sequence: Sequence.make(cursor),
            cursor: ThreadEventCursor.make(cursor),
            threadVersion: ThreadVersion.make(cursor),
            event,
            createdAt: Timestamp.make("2026-09-02T12:00:00.000Z"),
          },
        })

      yield* hosted.session.submit("first prompt")
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "sandbox-preparing")
      publishAdmissionEvent("1", {
        _tag: "SubmissionRejected",
        threadId: Thread.ThreadId.make("thread-1"),
        message: "rejected",
      })
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "executor-waiting")

      yield* hosted.session.submit("second prompt")
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "prompt-waiting")
      publishAdmissionEvent("2", {
        _tag: "QueueFull",
        threadId: Thread.ThreadId.make("thread-1"),
        capacity: 8,
        count: 8,
      })
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "executor-waiting")

      yield* hosted.session.submit("after sleep")
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "sandbox-waking")
      publishAdmissionEvent("3", {
        _tag: "SubmissionAdmitted",
        threadId: Thread.ThreadId.make("thread-1"),
        turnId: Turn.TurnId.make("turn-1"),
        status: "active",
      })
      yield* H.eventually(() => hosted.states.at(-1)?.activity === "executor-waiting")

      expect(hosted.states.some((state) => state.activity === "executor-waiting")).toBe(true)
      expect(
        hosted.states
          .map((state) => state.activity)
          .filter(
            (activity) =>
              activity === "sandbox-preparing" || activity === "prompt-waiting" || activity === "sandbox-waking",
          ),
      ).toEqual(["sandbox-preparing", "prompt-waiting", "sandbox-waking"])

      yield* hosted.session.quit
    }),
  ),
)

it.effect("publishes the attachment before the initial Thread list refresh completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>()
      const releaseRefresh = yield* Deferred.make<void>()
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const hosted = yield* H.runSession(
        harness,
        undefined,
        undefined,
        Deferred.succeed(refreshStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseRefresh)), Effect.as([])),
      )
      yield* Deferred.await(refreshStarted)
      yield* Effect.yieldNow
      expect(hosted.states.at(-1)?.connectivity).toBe("connected")
      expect(String(hosted.session.currentView()?.thread.id)).toBe("thread-1")
      yield* Deferred.succeed(releaseRefresh, undefined)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("publishes hosted Thread summaries and previews", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<InteractiveEvent> = []
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const summary = {
        id: Thread.ThreadId.make("thread-1"),
        workspace: "workspace-1",
        title: "Hosted Thread",
        pinned: false,
        archived: false,
        status: "idle" as const,
        unread: false,
        lastActivityAt: 1,
        turnCount: 1,
      }
      let summaries = [summary]
      const hosted = yield* H.runSession(
        harness,
        (receivedEvent) => received.push(receivedEvent),
        () => Effect.die("unused"),
        Effect.sync(() => summaries),
        () => Effect.succeed([]),
      )
      yield* H.eventually(() => received.some((receivedEvent) => receivedEvent._tag === "ThreadsListed"))
      expect(received.find((receivedEvent) => receivedEvent._tag === "ThreadsListed")).toEqual({
        _tag: "ThreadsListed",
        threads: [summary],
      })
      summaries = [{ ...summary, title: "Refreshed hosted Thread" }]
      yield* hosted.session.refreshThreads
      expect(received.findLast((receivedEvent) => receivedEvent._tag === "ThreadsListed")).toEqual({
        _tag: "ThreadsListed",
        threads: summaries,
      })
      yield* hosted.session.previewThread("thread-1", 7)
      expect(received.at(-1)).toEqual({
        _tag: "ThreadPreviewLoaded",
        threadId: "thread-1",
        requestId: 7,
        units: [],
      })
      yield* hosted.session.quit
    }),
  ),
)

it.effect("delivers hosted previews immediately and clears them after a best-effort gap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<InteractiveEvent> = []
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread")
          socket.frame(H.fixtures.attached(message, H.fixtures.waitingSnapshot()))
      })
      const hosted = yield* H.runSession(harness, (previewEvent) => received.push(previewEvent))
      harness.sockets[0]!.frame({
        _tag: "ThreadPreview",
        threadId: HostedThreadId.make("thread-1"),
        turnId: Turn.TurnId.make("turn-1"),
        preview: {
          _tag: "ModelPreview",
          runId: "run-1",
          attemptFence: 1,
          turn: 0,
          modelCallId: "call-1",
          modelAttemptId: "attempt-1",
          attempt: 1,
          sequence: 0,
          changes: [{ channel: "text", offset: 0, delta: "Hello" }],
        },
      })
      yield* H.eventually(
        () => received.filter((previewEvent) => previewEvent._tag === "ExecutionModelPreviewChanged").length === 1,
      )
      expect(received.at(-1)).toMatchObject({
        _tag: "ExecutionModelPreviewChanged",
        threadId: "thread-1",
        turnId: "turn-1",
        preview: { _tag: "ModelPreview", changes: [{ delta: "Hello" }] },
      })
      harness.sockets[0]!.frame({
        _tag: "ThreadPreviewReset",
        threadId: HostedThreadId.make("thread-1"),
      })
      yield* H.eventually(
        () => received.filter((previewEvent) => previewEvent._tag === "ExecutionModelPreviewChanged").length === 2,
      )
      expect(received.at(-1)).toMatchObject({
        _tag: "ExecutionModelPreviewChanged",
        preview: { _tag: "ModelPreviewCleared", runId: "run-1", generation: 0 },
      })
      yield* hosted.session.quit
    }),
  ),
)

it.effect("applies and acknowledges one unsolicited contiguous ThreadEvent exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<string> = []
      const harness = H.makeHarness(H.fixtures.defaultReceive)
      const hosted = yield* H.runSession(harness, (value) => received.push(value._tag))
      const update = H.fixtures.event("thread-1", "1")
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: update })
      yield* H.eventually(() => hosted.session.currentView()?.thread.updatedAt === 1)
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: update })
      yield* H.eventually(() => harness.messages.some((message) => message.command._tag === "AcknowledgeCursor"))
      expect(received.filter((tag) => tag === "ThreadViewSnapshot")).toHaveLength(2)
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(1)
      expect(
        harness.messages.filter(
          (message) => message.command._tag === "AcknowledgeCursor" && String(message.command.cursor) === "1",
        ),
      ).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("reconnects after the delivered cursor without duplicating the projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<string> = []
      const harness = H.makeHarness((socket, message, state) => {
        if (message.command._tag === "SubmitPrompt") {
          const submissions = state.messages.filter((candidate) => candidate.command._tag === "SubmitPrompt")
          if (submissions.length === 1) socket.close()
          else
            socket.frame({
              _tag: "CommandAccepted",
              requestId: message.requestId,
              commandId: message.command.commandId,
              threadId: message.command.threadId,
              threadVersion: ThreadVersion.make("1"),
              cursor: ThreadEventCursor.make("1"),
              result: { _tag: "Applied" },
            })
          return
        }
        if (message.command._tag !== "AttachThread") return
        const cursor = String(message.command.afterCursor)
        socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", Number(cursor)), cursor))
        if (state.sockets.length === 1) socket.frame({ _tag: "ThreadEvent", event: H.fixtures.event("thread-1", "1") })
      })
      const hosted = yield* H.runSession(harness, (value) => received.push(value._tag))
      yield* H.eventually(() => hosted.session.currentView()?.thread.updatedAt === 1)
      const submitted = yield* hosted.session
        .submit("disconnect", undefined, undefined, undefined, "disconnect")
        .pipe(Effect.forkScoped)
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* H.reconnect(harness)
      yield* Fiber.join(submitted)
      yield* H.eventually(
        () => harness.messages.filter((message) => message.command._tag === "AttachThread").length === 2,
      )
      const attaches = harness.messages.filter((message) => message.command._tag === "AttachThread")
      expect(
        attaches.map((message) => message.command._tag === "AttachThread" && String(message.command.afterCursor)),
      ).toEqual(["0", "1"])
      expect(received.filter((tag) => tag === "ThreadViewSnapshot")).toHaveLength(2)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("reattaches when admitted command versions are ahead of the replayed event cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachments = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          attachments += 1
          if (attachments === 1) {
            socket.frame(H.fixtures.attached(message, H.fixtures.waitingSnapshot()))
            return
          }
          socket.frame({
            _tag: "ThreadAttached",
            requestId: message.requestId,
            threadId: message.command.threadId,
            baseCursor: ThreadEventCursor.make("0"),
            threadVersion: ThreadVersion.make("2"),
            cursor: ThreadEventCursor.make("1"),
            events: [H.fixtures.event("thread-1", "1")],
            participants: [],
          })
          return
        }
        if (message.command._tag === "SubmitPrompt") {
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
      yield* hosted.session.submit("queued behind the active Turn")
      yield* hosted.session.cancel()
      harness.sockets[0]!.close()
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* H.reconnect(harness)
      yield* H.eventually(() => hosted.states.at(-1)?.connectivity === "connected")
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(1)
      yield* TestClock.adjust("10 seconds")
      expect(harness.sockets).toHaveLength(2)
      yield* hosted.session.quit
    }),
  ),
)
