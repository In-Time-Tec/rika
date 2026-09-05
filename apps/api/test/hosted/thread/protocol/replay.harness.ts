import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer } from "effect"
import { RequestId, ThreadEventCursor, ThreadVersion } from "@rika/product/hosted-model"
import { protocolVersion, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../../../../src/hosted/thread/application"
import { HostedProduct, type HostedProductService } from "../../../../src/hosted/product"
import {
  HostedThreadProtocol,
  type HostedThreadConnection,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
} from "../../../../src/hosted/thread/protocol"
import { makeThreadProtocolNotifications } from "../../../../src/hosted/thread/notifications"
import { HostedWorkspace } from "../../../../src/hosted/environment/workspace"

import { actor, memoryStore, ownerId, presenceLayer, snapshot, threadId, timestamp } from "./memory.fixture"

it.effect("streams a contiguous tail and resets compacted cursors from a durable checkpoint", () => {
  const store = memoryStore()
  const currentSnapshot: HostedThreadSnapshot = snapshot
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    createConnection: () => Effect.die("unused"),
    authorizeOwner: () => Effect.die("unused"),
    authorizeReadOwner: () => Effect.die("unused"),
    authorizeReadThread: () => Effect.die("unused"),
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () => Effect.die("unused"),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: () => Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const operations: HostedThreadApplicationService = {
    threads: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
    thread: () => Effect.succeed(currentSnapshot.view.thread),
    interactive: () => Effect.die("unused"),
    snapshot: () => Effect.succeed(currentSnapshot),
    history: () => Effect.die("unused"),
    projectionCommitted: () => Effect.die("unused"),
  }
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedThreadApplication, operations),
    Layer.succeed(
      HostedWorkspace,
      HostedWorkspace.of({
        execute: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        portal: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(ThreadProtocolStore, store),
    presenceLayer,
    BunCrypto.layer,
  )
  const snapshotWithTitle = (title: string): HostedThreadSnapshot => ({
    ...snapshot,
    view: { ...snapshot.view, thread: { ...snapshot.view.thread, title } },
  })
  const notifications = makeThreadProtocolNotifications()
  const pollOutbound = (connection: Pick<HostedThreadConnection, "outbound">) =>
    Effect.gen(function* () {
      const polling = yield* Effect.forkChild(connection.outbound, {
        startImmediately: true,
      })
      notifications.recover()
      return yield* Fiber.join(polling)
    })

  return Effect.scoped(
    Effect.gen(function* () {
      yield* store.saveSnapshot({
        ownerId,
        threadId,
        threadVersion: ThreadVersion.make("0"),
        cursor: ThreadEventCursor.make("0"),
        snapshot,
        createdAt: timestamp,
      })
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayerWithOptions({ notifications }).pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const connection = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      yield* connection.receive({
        protocolVersion,
        requestId: RequestId.make("attach-snapshot-race"),
        command: {
          _tag: "AttachThread",
          threadId,
          afterCursor: ThreadEventCursor.make("0"),
        },
      })

      const durableAhead = snapshotWithTitle("Durable one")
      const first = yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        { payload: { _tag: "ThreadEvent", event: { cursor: "1" } } },
      ])
      expect(store.snapshotSaves()).toBe(1)

      yield* store.checkpoint({
        ownerId,
        threadId,
        threadVersion: first[0]!.threadVersion,
        cursor: first[0]!.cursor,
        snapshot: durableAhead,
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "1",
            threadVersion: "0",
            snapshot: durableAhead,
          },
        },
      ])

      const durableBehind = snapshotWithTitle("Durable two")
      const second = yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        { payload: { _tag: "ThreadEvent", event: { cursor: "2" } } },
      ])
      yield* store.checkpoint({
        ownerId,
        threadId,
        threadVersion: second[0]!.threadVersion,
        cursor: second[0]!.cursor,
        snapshot: durableBehind,
        createdAt: timestamp,
      })
      store.dropEventsThrough("2")
      yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: timestamp,
      })
      const compacted = yield* protocol.connect("ticket-compacted", "/api/v1/threads/socket")
      expect(
        yield* compacted.receive({
          protocolVersion,
          requestId: RequestId.make("attach-compacted"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("1"),
            afterCheckpointCursor: ThreadEventCursor.make("1"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            baseCursor: "2",
            cursor: "3",
            checkpoint: { cursor: "2", snapshot: durableBehind },
            events: [{ cursor: "3" }],
          },
        },
      ])

      const current = yield* protocol.connect("ticket-current", "/api/v1/threads/socket")
      expect(
        yield* current.receive({
          protocolVersion,
          requestId: RequestId.make("attach-current"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("3"),
            afterCheckpointCursor: ThreadEventCursor.make("2"),
          },
        }),
      ).toMatchObject([{ payload: { _tag: "ThreadAttached", baseCursor: "3", cursor: "3", events: [] } }])
      expect(store.snapshotSaves()).toBe(1)
    }),
  )
})
