import { expect, it } from "@effect/vitest"
import { ThreadEventCursor, ThreadId } from "@rika/product/hosted-model"
import { rikaHostedThreads, rikaHostedThreadProtocolSnapshots, rikaThreads } from "@rika/product-store/database-schema"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { DateTime, Effect } from "effect"
import { command } from "./protocol/commands.harness"
import { live, setup, withDatabase } from "./protocol/database.harness"
import {
  actor,
  later,
  ownerId,
  snapshot,
  threadId,
  timestampAfter,
  userId,
  workspaceId,
} from "./protocol/values.harness"

it.effect.skipIf(!live)("keeps same-Thread order and Turn identity stable across worker interruption", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const first = command("interrupted-first", "0")
      const second = command("interrupted-second", "1")
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)

      const initial = yield* protocol.claimNextCommand({
        claimToken: "interrupted-worker",
        claimMillis: 60_000,
      })
      expect(initial).toMatchObject({ commandId: first.commandId, turnId: first.turnId })
      yield* protocol.releaseCommandClaim({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: "interrupted-worker",
      })

      const recovered = yield* protocol.claimNextCommand({
        claimToken: "recovered-worker",
        claimMillis: 60_000,
      })
      expect(recovered).toMatchObject({ commandId: first.commandId, turnId: first.turnId })
      yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: "recovered-worker",
        result: { _tag: "Applied" },
        events: [],
        completedAt: later,
      })

      expect(
        yield* protocol.claimNextCommand({
          claimToken: "next-worker",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: second.commandId, turnId: second.turnId })
    }),
  ),
)
it.effect.skipIf(!live)("claims another Thread while one Thread command lane is locked", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const aggregateDatabase = yield* PgDrizzle.makeWithDefaults()
      const otherThreadId = ThreadId.make("protocol-thread-other")
      yield* aggregateDatabase.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(rikaHostedThreads).values({
            id: otherThreadId,
            ownerId,
            projectId: null,
            workspaceId,
            createdByUserId: userId,
            executorKind: "runner",
            inheritProjectGrants: false,
            createdAt: DateTime.toDate(DateTime.nowUnsafe()),
          })
          yield* tx.insert(rikaThreads).values({
            id: otherThreadId,
            ownerId,
            workspace: workspaceId,
            title: "Other protocol thread",
            createdAt: 2,
            updatedAt: 2,
          })
        }),
      )
      yield* protocol.initializeThread({
        ownerId,
        threadId: otherThreadId,
        actor,
      })
      yield* protocol.admitCommand(command("locked-thread-command", "0"))
      yield* protocol.admitCommand({
        ...command("other-thread-command", "0"),
        threadId: otherThreadId,
      })

      const client = yield* Effect.tryPromise(() => pool.connect())
      yield* Effect.gen(function* () {
        yield* Effect.tryPromise(() => client.query("BEGIN"))
        yield* Effect.tryPromise(() =>
          client.query(`SELECT 1 FROM rika_hosted_thread_protocol_state WHERE thread_id = $1 FOR UPDATE`, [threadId]),
        )
        expect(
          yield* protocol.claimNextCommand({
            claimToken: "other-thread-claim",
            claimMillis: 60_000,
          }),
        ).toMatchObject({
          threadId: otherThreadId,
          commandId: "other-thread-command",
        })
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() => client.query("ROLLBACK")).pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => client.release())),
          ),
        ),
      )
    }),
  ),
)
it.effect.skipIf(!live)("does not let command cancellation overtake a non-prompt command", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const firstInput = command("service-before-cancel", "0")
      const first = {
        ...firstInput,
        command: {
          _tag: "EnsureRepositoryService",
          commandId: firstInput.commandId,
          service: { serviceId: "docs", command: "bun", args: ["run", "dev"], cwd: "." },
        },
      }
      const secondInput = command("cancel-service", "1")
      const second = {
        ...secondInput,
        command: {
          _tag: "Cancel",
          commandId: secondInput.commandId,
          target: { _tag: "Command", commandId: firstInput.commandId },
        },
      }
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "service-before-cancel-claim",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: first.commandId })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "cancel-service-claim",
          claimMillis: 60_000,
        }),
      ).toBeUndefined()
    }),
  ),
)
it.effect.skipIf(!live)("keeps event versions and snapshots monotonic when commands complete out of order", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const firstInput = command("completion-first", "0")
      const first = {
        ...firstInput,
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: firstInput.commandId,
          text: "complete after cancellation",
        },
      }
      const secondInput = command("completion-second", "1")
      const second = {
        ...secondInput,
        command: {
          _tag: "Cancel",
          threadId,
          commandId: secondInput.commandId,
          target: { _tag: "Command", commandId: firstInput.commandId },
        },
      }
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "completion-first-claim",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: first.commandId })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "completion-second-claim",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: second.commandId })

      const secondCompletion = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: second.commandId,
        claimToken: "completion-second-claim",
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: timestampAfter(60_000),
      })
      const firstCompletion = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: "completion-first-claim",
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: timestampAfter(120_000),
      })
      expect(secondCompletion.command).toMatchObject({
        threadVersion: "2",
        cursor: "1",
      })
      expect(firstCompletion.command).toMatchObject({
        threadVersion: "1",
        cursor: "2",
      })

      const events = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        includeSnapshot: false,
        limit: 100,
      })
      expect(events.events.map((event) => [event.cursor, event.threadVersion])).toEqual([
        ["1", "2"],
        ["2", "2"],
      ])
      const snapshots = yield* Effect.tryPromise(() =>
        drizzle({ client: pool })
          .select({
            threadVersion: rikaHostedThreadProtocolSnapshots.threadVersion,
            cursor: rikaHostedThreadProtocolSnapshots.cursor,
          })
          .from(rikaHostedThreadProtocolSnapshots)
          .where(eq(rikaHostedThreadProtocolSnapshots.threadId, threadId)),
      )
      expect(
        snapshots.map(({ threadVersion, cursor }) => ({ version: String(threadVersion), cursor: String(cursor) })),
      ).toMatchObject([{ version: "2", cursor: "1" }])
    }),
  ),
)
