import { expect, it } from "@effect/vitest"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { ThreadId as HostedThreadId, ThreadVersion, ThreadEventCursor } from "@rika/product/hosted-model"
import type { ThreadViewSnapshot } from "@rika/product/thread-view"
import { TurnId } from "@rika/product/turn-record"
import { encodeUnitOrder, unitOrder } from "@rika/transcript/transcript-unit-order"
import { Effect } from "effect"
import * as H from "./harness"

const page = (start: number, end: number, hasOlder: boolean): ThreadViewSnapshot => {
  const base = H.fixtures.waitingSnapshot().view
  const turn = base.turns[0]!
  const units = Array.from({ length: end - start }, (_, offset) => {
    const n = start + offset
    const key = `unit-${n}`
    return {
      key,
      turnId: "turn-1",
      order: unitOrder(key, n),
      revision: 1,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: key },
    }
  })
  const cursor = (n: number) => ({
    createdAt: 1,
    turnId: TurnId.make("turn-1"),
    orderKey: encodeUnitOrder(unitOrder(`unit-${n}`, n)),
  })
  return {
    ...base,
    turns: [{ ...turn, units }],
    hasOlder,
    source: { ...base.source, oldestCursor: cursor(start), newestCursor: cursor(end - 1) },
  }
}

it.effect("ignores an old historical response after switching Threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pending: H.Message | undefined
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          const snapshot = H.fixtures.snapshot(String(message.command.threadId), 2)
          socket.frame(
            H.fixtures.attached(
              message,
              message.command.threadId === "thread-1" ? { ...snapshot, view: page(2, 4, true) } : snapshot,
            ),
          )
        }
        if (message.command._tag === "ReadThreadHistory") pending = message
      })
      const events: Array<InteractiveEvent> = []
      const hosted = yield* H.runSession(harness, (event) => events.push(event))
      yield* H.eventually(() => pending !== undefined)
      yield* hosted.session.selectThread("thread-2")
      const request = pending!
      if (request.command._tag !== "ReadThreadHistory") throw new Error("Expected history request")
      harness.sockets[0]!.frame({
        _tag: "ThreadHistory",
        requestId: request.requestId,
        threadId: request.command.threadId,
        before: request.command.before,
        view: page(0, 2, false),
      })
      yield* Effect.yieldNow
      expect(hosted.session.currentView()?.thread.id).toBe("thread-2")
      const last = events.findLast((event) => event._tag === "ThreadViewSnapshot")
      expect(last?._tag === "ThreadViewSnapshot" && last.snapshot.thread.id).toBe("thread-2")
      yield* hosted.session.quit
    }),
  ),
)

it.effect("resumes interrupted history loading after reconnecting to an identical checkpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread")
          socket.frame(H.fixtures.attached(message, { ...H.fixtures.snapshot("thread-1", 2), view: page(2, 4, true) }))
        if (message.command._tag === "ReadThreadHistory") {
          reads++
          if (reads > 1)
            socket.frame({
              _tag: "ThreadHistory",
              requestId: message.requestId,
              threadId: message.command.threadId,
              before: message.command.before,
              view: page(0, 2, false),
            })
        }
      })
      const events: Array<InteractiveEvent> = []
      const hosted = yield* H.runSession(harness, (event) => events.push(event))
      yield* H.eventually(() => reads === 1)
      harness.sockets[0]!.close()
      yield* H.reconnect(harness)
      yield* H.eventually(() =>
        events.some(
          (event) =>
            event._tag === "ThreadViewSnapshot" &&
            !event.snapshot.hasOlder &&
            event.snapshot.turns[0]?.units.length === 4,
        ),
      )
      expect(reads).toBe(2)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("automatically reads every older page over the interactive transport and retains history on refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0
      const newest = page(4, 6, true)
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, { ...H.fixtures.snapshot("thread-1", 2), view: newest }))
        } else if (message.command._tag === "ReadThreadHistory") {
          reads++
          socket.frame({
            _tag: "ThreadHistory",
            requestId: message.requestId,
            threadId: message.command.threadId,
            before: message.command.before,
            view: reads === 1 ? page(2, 4, true) : page(0, 2, false),
          })
        }
      })
      const events: Array<InteractiveEvent> = []
      const hosted = yield* H.runSession(harness, (event) => events.push(event))
      yield* H.eventually(() =>
        events.some(
          (event) =>
            event._tag === "ThreadViewSnapshot" &&
            !event.snapshot.hasOlder &&
            event.snapshot.turns[0]?.units.length === 6,
        ),
      )
      expect(reads).toBe(2)
      harness.sockets[0]!.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("0"),
        cursor: ThreadEventCursor.make("0"),
        snapshot: { ...H.fixtures.snapshot("thread-1", 2), view: { ...newest, revision: 3 } },
      })
      yield* H.eventually(() =>
        events.some((event) => event._tag === "ThreadViewSnapshot" && event.snapshot.revision === 3),
      )
      const snapshot = events.findLast((event) => event._tag === "ThreadViewSnapshot")
      expect(
        snapshot?._tag === "ThreadViewSnapshot" && snapshot.snapshot.turns[0]?.units.map((unit) => unit.key),
      ).toEqual(["unit-0", "unit-1", "unit-2", "unit-3", "unit-4", "unit-5"])
      expect(reads).toBe(2)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("reports a non-progressing history page without dropping the current transcript or retrying forever", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0
      const newest = page(4, 6, true)
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread")
          socket.frame(H.fixtures.attached(message, { ...H.fixtures.snapshot("thread-1", 2), view: newest }))
        if (message.command._tag === "ReadThreadHistory") {
          reads++
          socket.frame({
            _tag: "ThreadHistory",
            requestId: message.requestId,
            threadId: message.command.threadId,
            before: message.command.before,
            view: newest,
          })
        }
      })
      const events: Array<InteractiveEvent> = []
      const hosted = yield* H.runSession(harness, (event) => events.push(event))
      yield* H.eventually(() =>
        events.some((event) => event._tag === "ThreadHistoryStatus" && event.status === "failed"),
      )
      expect(reads).toBe(1)
      expect(hosted.states.at(-1)?.connectivity).toBe("connected")
      yield* hosted.session.quit
    }),
  ),
)
