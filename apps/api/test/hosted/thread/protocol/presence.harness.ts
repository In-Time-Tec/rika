import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, DateTime, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { RequestId, ThreadEventCursor, ThreadVersion } from "@rika/product/hosted-model"
import { HostedPresence, type UpsertHostedPresenceInput } from "@rika/product/hosted-presence"
import { protocolVersion } from "@rika/product/client-protocol"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../../../../src/hosted/thread/application"
import { HostedProduct, type HostedProductService } from "../../../../src/hosted/product"
import {
  HostedThreadProtocol,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
} from "../../../../src/hosted/thread/protocol"
import { presenceRefreshMillis } from "../../../../src/hosted/thread/protocol-connection"
import { makeThreadProtocolNotifications } from "../../../../src/hosted/thread/notifications"
import { HostedWorkspace } from "../../../../src/hosted/environment/workspace"

import { actor, memoryStore, ownerId, snapshot, threadId, timestamp } from "./memory.fixture"

it.effect("keeps an attached viewer's presence live and marks it away when the socket closes", () => {
  const store = memoryStore()
  const writes: Array<Pick<UpsertHostedPresenceInput, "status" | "now" | "expiresAt">> = []
  const recordingPresence = Layer.succeed(HostedPresence, {
    upsert: (input) =>
      Effect.sync(() => {
        writes.push({ status: input.status, now: input.now, expiresAt: input.expiresAt })
        return {
          ownerId: input.ownerId,
          threadId: input.threadId,
          actor: input.actor,
          status: input.status,
          lastSeenAt: input.now,
          expiresAt: input.expiresAt,
        }
      }),
    list: () => Effect.succeed([]),
  })
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
    thread: () => Effect.succeed(snapshot.view.thread),
    interactive: () => Effect.die("unused"),
    snapshot: () => Effect.succeed(snapshot),
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
    recordingPresence,
    BunCrypto.layer,
  )
  const notifications = makeThreadProtocolNotifications()

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
        requestId: RequestId.make("attach-presence"),
        command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("0") },
      })
      expect(writes.map((write) => write.status)).toEqual(["viewing"])

      // Nothing durable happens; the idle outbound wait must still refresh presence before it expires.
      const idle = yield* Effect.forkChild(connection.outbound, { startImmediately: true })
      yield* TestClock.adjust(presenceRefreshMillis)
      expect(yield* Fiber.join(idle)).toEqual([])
      expect(writes.map((write) => write.status)).toEqual(["viewing", "viewing"])
      expect(
        DateTime.toEpochMillis(DateTime.makeUnsafe(writes[1]!.expiresAt)) -
          DateTime.toEpochMillis(DateTime.makeUnsafe(writes[1]!.now)),
      ).toBe(60_000)

      // A second wait immediately after a refresh does not write again until the next interval.
      const early = yield* Effect.forkChild(connection.outbound, { startImmediately: true })
      yield* TestClock.adjust(presenceRefreshMillis - 1)
      expect(writes.map((write) => write.status)).toEqual(["viewing", "viewing"])
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(early)).toEqual([])
      expect(writes.map((write) => write.status)).toEqual(["viewing", "viewing", "viewing"])

      yield* connection.detach
      expect(writes.map((write) => write.status)).toEqual(["viewing", "viewing", "viewing", "away"])
      expect(writes[3]!.expiresAt).toBe(writes[3]!.now)
    }),
  )
})
