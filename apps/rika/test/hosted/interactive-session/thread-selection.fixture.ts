import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ThreadEventCursor, ThreadVersion, ThreadId as HostedThreadId } from "@rika/product/hosted-model"
import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import * as H from "./harness"

it.effect("retains the newer Thread when a superseded selection receives late frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag !== "AttachThread") return
        const threadId = String(message.command.threadId)
        socket.frame(
          H.fixtures.attached(
            message,
            H.fixtures.snapshot(threadId, threadId === "thread-new" ? 2 : 0),
            threadId === "thread-new" ? "2" : "0",
          ),
        )
      })
      const hosted = yield* H.runSession(harness)
      yield* hosted.session.selectThread("thread-old")
      yield* hosted.session.selectThread("thread-new")
      harness.sockets.at(-1)!.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-old"),
        threadVersion: ThreadVersion.make("9"),
        cursor: ThreadEventCursor.make("9"),
        snapshot: H.fixtures.snapshot("thread-old", 9),
      })
      harness.sockets.at(-1)!.frame({ _tag: "ThreadEvent", event: H.fixtures.event("thread-old", "9") })
      yield* Effect.yieldNow
      expect(String(hosted.session.currentView()?.thread.id)).toBe("thread-new")
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(2)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("archives the current Thread and selects a new Runner Thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const created: Array<{ executorKind: "runner" | "orb"; archiveThreadId?: string }> = []
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          const threadId = String(message.command.threadId)
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot(threadId, 0)))
        }
      })
      const hosted = yield* H.runSession(harness, undefined, (executorKind, archiveThreadId) => {
        created.push(archiveThreadId === undefined ? { executorKind } : { executorKind, archiveThreadId })
        return Effect.succeed("thread-2")
      })
      yield* hosted.session.archiveAndNewThread
      yield* H.eventually(() => String(hosted.session.currentView()?.thread.id) === "thread-2")
      expect(created).toEqual([{ executorKind: "runner", archiveThreadId: "thread-1" }])
      expect(harness.messages.map((message) => message.command._tag)).not.toContain("ArchiveThread")
      yield* hosted.session.quit
    }),
  ),
)

it.effect("edits and removes queued Turns through durable Thread commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let version = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(H.fixtures.attached(message, H.fixtures.snapshot("thread-1", version)))
          return
        }
        if (message.command._tag !== "EditQueued" && message.command._tag !== "Dequeue") return
        version += 1
        socket.frame({
          _tag: "CommandAccepted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make(String(version)),
          cursor: ThreadEventCursor.make("0"),
          result: { _tag: "Applied" },
        })
      })
      const hosted = yield* H.runSession(harness)
      yield* hosted.session.editQueued("turn-2", "rewritten prompt")
      yield* hosted.session.dequeue("turn-3")
      expect(
        harness.messages
          .map((message) => message.command)
          .filter((command) => command._tag === "EditQueued" || command._tag === "Dequeue"),
      ).toMatchObject([
        {
          _tag: "EditQueued",
          turnId: "turn-2",
          prompt: "rewritten prompt",
          expectedThreadVersion: "0",
        },
        { _tag: "Dequeue", turnId: "turn-3", expectedThreadVersion: "1" },
      ])
      yield* hosted.session.quit
    }),
  ),
)

it.effect("maps Runner waiting snapshots to executor-waiting with or without migration workspace data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachCount = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag !== "AttachThread") return
        attachCount += 1
        const workspace = attachCount === 1 ? undefined : ({ _tag: "RunnerWorkspace", state: "ready" } as const)
        socket.frame(H.fixtures.attached(message, H.fixtures.waitingSnapshot("runner", workspace), String(attachCount)))
      })
      const hosted = yield* H.runSession(harness)
      expect(hosted.states.at(-1)?.activity).toBe("executor-waiting")
      yield* hosted.session.reopenThread
      expect(hosted.states.at(-1)?.activity).toBe("executor-waiting")
      yield* hosted.session.quit
    }),
  ),
)

it.effect("consumes typed OrbWorkspace preparing and failed snapshots without legacy status frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachCount = 0
      const harness = H.makeHarness((socket, message) => {
        if (message.command._tag !== "AttachThread") return
        attachCount += 1
        const state = attachCount === 1 ? "preparing" : "failed"
        const workspace: HostedThreadSnapshot["workspace"] =
          state === "failed"
            ? { _tag: "OrbWorkspace", state, generation: "generation-1", message: "checkout failed" }
            : { _tag: "OrbWorkspace", state, generation: "generation-1" }
        socket.frame(H.fixtures.attached(message, H.fixtures.waitingSnapshot("orb", workspace), String(attachCount)))
      })
      const hosted = yield* H.runSession(harness)
      expect(hosted.states.at(-1)?.activity).toBe("workspace-preparing")
      yield* hosted.session.reopenThread
      expect(hosted.states.at(-1)?.activity).toBe("workspace-failed")
      yield* hosted.session.quit
    }),
  ),
)
