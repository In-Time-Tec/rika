import { expect, it } from "@effect/vitest"
import { ThreadEventCursor } from "@rika/product/hosted-model"
import { rikaHostedThreadProtocolEvents, rikaHostedThreadProtocolSnapshots } from "@rika/product-store/database-schema"
import { migrations } from "@rika/product-store/migrations"
import { count, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { DateTime, Effect, FileSystem } from "effect"
import { live, setup, withDatabase } from "./database.harness"
import { actor, later, ownerId, snapshot, threadId } from "./values.harness"

const legacySnapshot = {
  ...snapshot,
  view: {
    ...snapshot.view,
    turns: [{ units: [{ content: { block: { _tag: "Cell", cellId: "legacy" } } }] }],
  },
}

it.effect.skipIf(!live)("replays and appends past persisted rows the current contract cannot decode", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const createdAt = DateTime.toDate(DateTime.makeUnsafe(later))
      const first = yield* protocol.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: later,
      })
      // Rows written by a release whose contract still had `Cell` blocks and `GoalChanged` events.
      yield* Effect.tryPromise(() =>
        db.insert(rikaHostedThreadProtocolSnapshots).values({
          ownerId,
          threadId,
          threadVersion: Number(first[0]!.threadVersion),
          cursor: Number(first[0]!.cursor),
          snapshot: legacySnapshot,
          createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(rikaHostedThreadProtocolEvents).values({
          ownerId,
          threadId,
          sequence: 2,
          cursor: 2,
          threadVersion: Number(first[0]!.threadVersion),
          event: { _tag: "GoalChanged", goal: "legacy" },
          createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        pool.query(
          `UPDATE rika_hosted_thread_protocol_state SET event_cursor = 2 WHERE owner_id = $1 AND thread_id = $2`,
          [ownerId, threadId],
        ),
      )

      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(replay.snapshot).toBeUndefined()
      expect(replay.events.map((event) => event.cursor)).toEqual(["1"])
      expect(replay.cursor).toBe("2")

      const appended = yield* protocol.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        createdAt: later,
      })
      expect(appended[0]?.cursor).toBe("3")
      const replaced = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(replaced.snapshot).toMatchObject({ cursor: "3", snapshot })

      const purge = migrations.find(({ id }) => id === "product/0044_purge_legacy_cell_presentation")!
      const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(purge.url.pathname),
      )
      yield* Effect.tryPromise(() => pool.query(sql))
      const [snapshots] = yield* Effect.tryPromise(() =>
        db
          .select({ value: count() })
          .from(rikaHostedThreadProtocolSnapshots)
          .where(eq(rikaHostedThreadProtocolSnapshots.threadId, threadId)),
      )
      const [events] = yield* Effect.tryPromise(() =>
        db
          .select({ value: count() })
          .from(rikaHostedThreadProtocolEvents)
          .where(eq(rikaHostedThreadProtocolEvents.threadId, threadId)),
      )
      expect(snapshots?.value).toBe(0)
      expect(events?.value).toBe(0)
    }),
  ),
)
