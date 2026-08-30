import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { RequestId, ThreadEventCursor } from "@rika/product/hosted-model"
import { protocolVersion, type HostedThreadSnapshot, type ServerFrame } from "@rika/product/client-protocol"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { rikaHostedThreadProtocolEvents } from "@rika/product-store/database-schema"
import { count, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Context, Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { HostedProduct } from "../../../src/hosted/product"
import {
  HostedThreadProtocol,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
  threadWebSocketAudience,
} from "../../../src/hosted/thread/protocol"
import { HostedToolPolicy } from "../../../src/hosted/execution/tool-policy"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { testToolPolicy } from "../execution/tool-policy.fixture"
import { live, setup, withDatabase } from "./protocol/database.harness"
import { fakeApplication, fakeProduct, fakeWorkspace } from "./protocol/fakes.harness"
import { actor, clientId, deviceId, later, ownerId, snapshot, threadId, userId } from "./protocol/values.harness"

it.effect.skipIf(!live)("resets compacted replica gaps and pushes contiguous events after listener recovery", () =>
  withDatabase((pool, url) =>
    Effect.gen(function* () {
      const protocolStore = yield* setup(pool)
      const db = drizzle({ client: pool })
      let currentSnapshot: HostedThreadSnapshot = snapshot
      const product = fakeProduct({
        projects: () => Effect.succeed([]),
        activatePrincipal: () => Effect.void,
        authorizeThread: () => Effect.succeed({ ownerId, actor }),
      })
      const operations = fakeApplication({
        thread: () => Effect.succeed(currentSnapshot.view.thread),
        snapshot: () => Effect.succeed(currentSnapshot),
      })
      const dependencies = Layer.mergeAll(
        Layer.succeed(HostedProduct, product),
        Layer.succeed(HostedThreadApplication, operations),
        Layer.succeed(HostedWorkspace, fakeWorkspace()),
        Layer.succeed(ThreadProtocolStore, protocolStore),
        Layer.succeed(HostedToolPolicy, testToolPolicy),
        BunCrypto.layer,
      )
      const replica = () =>
        Layer.build(
          hostedThreadProtocolLayerWithOptions({
            databaseUrl: Redacted.make(url),
          }).pipe(Layer.provide(dependencies)),
        ).pipe(Effect.map((context) => Context.get(context, HostedThreadProtocol)))
      const [replicaA, replicaB] = yield* Effect.all([replica(), replica()], {
        concurrency: "unbounded",
      })
      const principal = { userId, clientId, deviceId }
      const open = (protocol: HostedThreadProtocol["Service"], requestId: string) =>
        Effect.gen(function* () {
          const ticket = yield* protocol.issueTicket(principal)
          const connection = yield* protocol.connect(ticket.ticket, threadWebSocketAudience)
          expect(
            yield* connection.receive({
              protocolVersion,
              requestId: RequestId.make(requestId),
              command: {
                _tag: "AttachThread",
                threadId,
                afterCursor: ThreadEventCursor.make("0"),
              },
            }),
          ).toMatchObject([{ payload: { _tag: "ThreadAttached", cursor: "0" } }])
          return connection
        })
      const [connectionA, connectionB] = yield* Effect.all([open(replicaA, "replica-a"), open(replicaB, "replica-b")], {
        concurrency: "unbounded",
      })
      const listenerPids = Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const listeners = yield* Effect.tryPromise(() =>
            pool.query<{ readonly pid: number }>(
              `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN rika_thread_protocol'`,
            ),
          )
          if (listeners.rows.length === 2) return listeners.rows.map((row) => row.pid)
          yield* TestClock.adjust("25 millis")
        }
        return yield* Effect.die("Thread protocol listeners did not become ready")
      })
      const initialListeners = yield* listenerPids
      const publish = (updatedAt: number) =>
        Effect.gen(function* () {
          currentSnapshot = {
            ...currentSnapshot,
            view: {
              ...currentSnapshot.view,
              thread: { ...currentSnapshot.view.thread, updatedAt },
              revision: updatedAt,
            },
          }
          const appended = yield* protocolStore.appendEvents({
            ownerId,
            threadId,
            events: [{ _tag: "ThreadViewSnapshot", snapshot: currentSnapshot.view }],
            createdAt: later,
          })
          yield* protocolStore.saveSnapshot({
            ownerId,
            threadId,
            threadVersion: appended[0]!.threadVersion,
            cursor: appended[0]!.cursor,
            snapshot: currentSnapshot,
            createdAt: later,
          })
        })
      const eventCursors = (frames: ReadonlyArray<ServerFrame>) =>
        frames.flatMap((frame) => (frame.payload._tag === "ThreadEvent" ? [String(frame.payload.event.cursor)] : []))
      yield* publish(2)
      expect(eventCursors(yield* connectionA.outbound)).toEqual(["1"])
      expect(
        yield* connectionA.receive({
          protocolVersion,
          requestId: RequestId.make("replica-a-ack"),
          command: {
            _tag: "AcknowledgeCursor",
            threadId,
            cursor: ThreadEventCursor.make("1"),
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAccepted", cursor: "1" } }])
      const eventCounts = yield* Effect.tryPromise(() =>
        db
          .select({ value: count() })
          .from(rikaHostedThreadProtocolEvents)
          .where(eq(rikaHostedThreadProtocolEvents.threadId, threadId)),
      )
      expect(eventCounts[0]?.value).toBe(0)
      expect(yield* connectionB.outbound).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "1",
            snapshot: currentSnapshot,
          },
        },
      ])
      yield* Effect.tryPromise(() =>
        pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])`, [
          initialListeners,
        ]),
      )
      yield* TestClock.adjust("1 second")
      let recoveredListeners: ReadonlyArray<number> = []
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const listeners = yield* Effect.tryPromise(() =>
          pool.query<{ readonly pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN rika_thread_protocol'`,
          ),
        )
        recoveredListeners = listeners.rows.map((row) => row.pid)
        if (recoveredListeners.length === 2 && recoveredListeners.every((pid) => !initialListeners.includes(pid))) break
        yield* TestClock.adjust("25 millis")
      }
      expect(recoveredListeners).toHaveLength(2)
      expect(recoveredListeners.every((pid) => !initialListeners.includes(pid))).toBe(true)
      yield* publish(3)
      const second = yield* Effect.all([connectionA.outbound, connectionB.outbound], { concurrency: "unbounded" })
      expect(second.map(eventCursors)).toEqual([["2"], ["2"]])
    }),
  ),
)
