import { expect, it } from "@effect/vitest"
import { ThreadEventCursor } from "@rika/product/hosted-model"
import { rikaHostedThreadProtocolCommands } from "@rika/product-store/database-schema"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { DateTime, Effect } from "effect"
import { command } from "./protocol/commands.harness"
import { live, setup, withDatabase } from "./protocol/database.harness"
import { actor, clientId, deviceId, later, now, ownerId, snapshot, threadId, userId } from "./protocol/values.harness"

it.effect.skipIf(!live)("serializes controllers, replays cursors, and consumes socket tickets once", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const duplicate = command("duplicate", "0")
      const deliveries = yield* Effect.all([protocol.admitCommand(duplicate), protocol.admitCommand(duplicate)], {
        concurrency: "unbounded",
      })
      expect(deliveries.filter((delivery) => delivery._tag === "Admitted")).toHaveLength(1)
      expect(deliveries.filter((delivery) => delivery._tag === "Duplicate")).toHaveLength(1)
      const firstClaimToken = "duplicate-claim-first"
      expect(
        yield* protocol.claimNextCommand({
          claimToken: firstClaimToken,
          claimMillis: 60_000,
        }),
      ).toMatchObject({
        commandId: duplicate.commandId,
      })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "duplicate-claim-busy",
          claimMillis: 60_000,
        }),
      ).toBeUndefined()
      yield* Effect.tryPromise(() =>
        db
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: DateTime.toDate(DateTime.makeUnsafe(0)) })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.threadId, threadId),
              eq(rikaHostedThreadProtocolCommands.commandId, duplicate.commandId),
            ),
          ),
      )
      const claimToken = "duplicate-claim-recovered"
      expect(yield* protocol.claimNextCommand({ claimToken, claimMillis: 60_000 })).toMatchObject({
        commandId: duplicate.commandId,
      })
      expect(
        yield* protocol.renewCommandClaim({
          ownerId,
          threadId,
          commandId: duplicate.commandId,
          claimToken: firstClaimToken,
          claimMillis: 60_000,
        }),
      ).toBe(false)
      yield* protocol.releaseCommandClaim({
        ownerId,
        threadId,
        commandId: duplicate.commandId,
        claimToken: firstClaimToken,
      })
      expect(
        yield* protocol.renewCommandClaim({
          ownerId,
          threadId,
          commandId: duplicate.commandId,
          claimToken,
          claimMillis: 60_000,
        }),
      ).toBe(true)
      expect(
        yield* protocol
          .completeCommand({
            ownerId,
            threadId,
            commandId: duplicate.commandId,
            claimToken: firstClaimToken,
            result: { _tag: "Applied" },
            events: [],
            completedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })
      const completed = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: duplicate.commandId,
        claimToken,
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: later,
      })
      expect(completed).toMatchObject({
        _tag: "Completed",
        command: { state: "completed", threadVersion: "1", cursor: "1" },
      })
      expect(yield* protocol.admitCommand(duplicate)).toMatchObject({
        _tag: "Duplicate",
        command: completed.command,
      })
      expect(
        yield* protocol
          .admitCommand({
            ...duplicate,
            command: { _tag: "Cancel", payload: "changed" },
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
      expect(
        yield* protocol
          .admitCommand({
            ...command("different-command", "1"),
            idempotencyKey: duplicate.idempotencyKey,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })

      const races = yield* Effect.all(
        [command("controller-a", "1"), command("controller-b", "1")].map((input) =>
          protocol.admitCommand(input).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      )
      expect(races.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(races.filter((result) => result._tag === "Failure")).toMatchObject([
        { failure: { reason: "stale-version" } },
      ])

      const appended = yield* protocol.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: later,
      })
      yield* protocol.checkpoint({
        ownerId,
        threadId,
        threadVersion: appended[0]!.threadVersion,
        cursor: appended[0]!.cursor,
        snapshot,
        createdAt: later,
      })
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(replay).toMatchObject({
        threadVersion: "2",
        cursor: "2",
        snapshot: { cursor: "1" },
      })
      expect(replay.events).toMatchObject([{ cursor: "2" }])
      expect(
        yield* protocol.acknowledgeCursor({
          ownerId,
          threadId,
          actor,
          cursor: ThreadEventCursor.make("1"),
          acknowledgedAt: later,
        }),
      ).toMatchObject({ acknowledgedCursor: "1", headCursor: "2", threadVersion: "2" })
      const compacted = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(compacted.snapshot?.cursor).toBe("1")
      expect(compacted.events).toMatchObject([{ cursor: "2" }])

      yield* protocol.issueTicket({
        ticketId: "ticket",
        ticketDigest: "digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      const redemptions = yield* Effect.all(
        [1, 2].map(() =>
          protocol
            .redeemTicket({
              ticketDigest: "digest",
              audience: "/api/v1/threads/socket",
              redeemedAt: now,
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      )
      expect(redemptions.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(redemptions.filter((result) => result._tag === "Failure")).toHaveLength(1)

      yield* protocol.issueTicket({
        ticketId: "audience-ticket",
        ticketDigest: "audience-digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      expect(
        yield* protocol
          .redeemTicket({
            ticketDigest: "audience-digest",
            audience: "/wrong",
            redeemedAt: now,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })

      yield* protocol.issueTicket({
        ticketId: "revoked-ticket",
        ticketDigest: "revoked-digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      yield* protocol.revokeTicket("revoked-ticket")
      expect(
        yield* protocol
          .redeemTicket({
            ticketDigest: "revoked-digest",
            audience: "/api/v1/threads/socket",
            redeemedAt: now,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })

      yield* protocol.issueTicket({
        ticketId: "expired-ticket",
        ticketDigest: "expired-digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      expect(
        yield* protocol
          .redeemTicket({
            ticketDigest: "expired-digest",
            audience: "/api/v1/threads/socket",
            redeemedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })
    }),
  ),
)
it.effect.skipIf(!live)("claims one admitted command, reclaims expiry, and includes Thread creation", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const input = command("worker-command", "0")
      yield* protocol.admitCommand(input)
      const claims = yield* Effect.all(
        ["worker-claim-a", "worker-claim-b"].map((claimToken) =>
          protocol.claimNextCommand({ claimToken, claimMillis: 60_000 }),
        ),
        { concurrency: "unbounded" },
      )
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
      expect(claims.find((claim) => claim !== undefined)).toMatchObject({
        commandId: input.commandId,
      })

      yield* Effect.tryPromise(() =>
        db
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: DateTime.toDate(DateTime.makeUnsafe(0)) })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.threadId, threadId),
              eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
            ),
          ),
      )
      const recovered = yield* protocol.claimNextCommand({
        claimToken: "worker-claim-recovered",
        claimMillis: 60_000,
      })
      expect(recovered).toMatchObject({ commandId: input.commandId })
      yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: input.commandId,
        claimToken: "worker-claim-recovered",
        result: { _tag: "Applied" },
        events: [],
        completedAt: later,
      })

      yield* protocol.admitCommand({
        ...command("create-command", "1"),
        command: { _tag: "CreateThread" },
      })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "worker-claim-create",
          claimMillis: 60_000,
        }),
      ).toMatchObject({
        commandId: "create-command",
        command: { _tag: "CreateThread" },
      })
    }),
  ),
)
it.effect.skipIf(!live)("claims ordinary commands in Thread version order across concurrent workers", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const first = command("ordered-first", "0")
      const second = command("ordered-second", "1")
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)

      const attempts = ["ordered-worker-a", "ordered-worker-b"]
      const claims = yield* Effect.all(
        attempts.map((claimToken) => protocol.claimNextCommand({ claimToken, claimMillis: 60_000 })),
        { concurrency: "unbounded" },
      )
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
      expect(claims.find((claim) => claim !== undefined)).toMatchObject({
        commandId: first.commandId,
      })

      const claimedIndex = claims.findIndex((claim) => claim !== undefined)
      yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: attempts[claimedIndex]!,
        result: { _tag: "Applied" },
        events: [],
        completedAt: now,
      })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "ordered-worker-next",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: second.commandId })
    }),
  ),
)
