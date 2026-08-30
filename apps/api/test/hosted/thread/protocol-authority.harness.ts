import { expect, it } from "@effect/vitest"
import { identityMember, identityOrganization } from "@rika/identity"
import {
  BetterAuthMemberId,
  CommandId,
  IdempotencyKey,
  OrganizationId,
  OwnerId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedPresence } from "@rika/product/hosted-presence"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import {
  rikaHostedClientAuthorities,
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { DateTime, Effect } from "effect"
import { live, setup, withDatabase } from "./protocol/database.harness"
import {
  actor,
  authorityExpiresAt,
  clientId,
  deviceId,
  later,
  now,
  ownerId,
  presenceExpiresAt,
  snapshot,
  threadId,
  userId,
} from "./protocol/values.harness"

it.effect.skipIf(!live)("revokes organization authority without revoking the same client's personal authority", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const aggregateDatabase = yield* PgDrizzle.makeWithDefaults()
      const authority = yield* HostedClientAuthority
      const presence = yield* HostedPresence
      const organizationId = OrganizationId.make("protocol-organization")
      const membershipId = BetterAuthMemberId.make("protocol-membership")
      const organizationOwnerId = OwnerId.make("protocol-organization-owner")
      const organizationWorkspaceId = WorkspaceId.make("protocol-organization-workspace")
      const organizationThreadId = ThreadId.make("protocol-organization-thread")
      const organizationActor = {
        _tag: "OrganizationActor" as const,
        owner: { _tag: "OrganizationOwner" as const, organizationId },
        userId,
        membershipId,
        clientId,
        deviceId,
      }
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        db.insert(identityOrganization).values({
          id: organizationId,
          name: "Protocol",
          slug: "protocol",
          createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(identityMember).values({
          id: membershipId,
          organizationId,
          userId,
          role: "owner",
          createdAt,
        }),
      )
      yield* aggregateDatabase.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(rikaHostedOwners).values({ id: organizationOwnerId, kind: "organization", organizationId })
          yield* tx.insert(rikaHostedOwnerCounters).values({ ownerId: organizationOwnerId })
          yield* tx.insert(rikaHostedWorkspaces).values({
            id: organizationWorkspaceId,
            ownerId: organizationOwnerId,
            projectId: null,
            createdByUserId: userId,
            executorKind: "runner",
            inheritProjectGrants: false,
            createdAt,
          })
          yield* tx
            .insert(rikaWorkspaces)
            .values({ ownerId: organizationOwnerId, path: organizationWorkspaceId, createdAt: 1 })
          yield* tx.insert(rikaHostedThreads).values({
            id: organizationThreadId,
            ownerId: organizationOwnerId,
            projectId: null,
            workspaceId: organizationWorkspaceId,
            createdByUserId: userId,
            executorKind: "runner",
            inheritProjectGrants: false,
            createdAt,
          })
          yield* tx.insert(rikaThreads).values({
            id: organizationThreadId,
            ownerId: organizationOwnerId,
            workspace: organizationWorkspaceId,
            title: "Organization protocol thread",
            createdAt: 1,
            updatedAt: 1,
          })
        }),
      )
      yield* authority.grantClientAuthority({
        ownerId: organizationOwnerId,
        actor: organizationActor,
        now,
        expiresAt: authorityExpiresAt,
      })
      yield* protocol.initializeThread({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        actor: organizationActor,
      })
      const organizationAdmission = yield* protocol.admitCommand({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        commandId: CommandId.make("organization-command"),
        turnId: TurnId.make("turn-organization-command"),
        idempotencyKey: IdempotencyKey.make("organization-command-key"),
        expectedThreadVersion: ThreadVersion.make("0"),
        actor: organizationActor,
        command: { _tag: "Cancel" },
        admittedAt: now,
      })
      const organizationClaimToken = "organization-claim"
      expect(
        yield* protocol.claimNextCommand({
          claimToken: organizationClaimToken,
          claimMillis: 60_000,
        }),
      ).toMatchObject({
        commandId: organizationAdmission.command.commandId,
      })
      yield* protocol.completeCommand({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        commandId: organizationAdmission.command.commandId,
        claimToken: organizationClaimToken,
        result: { _tag: "Applied" },
        events: [],
        snapshot: {
          ...snapshot,
          view: {
            ...snapshot.view,
            thread: {
              ...snapshot.view.thread,
              id: ProductThreadId.make(organizationThreadId),
              workspace: organizationWorkspaceId,
            },
          },
        },
        completedAt: later,
      })
      yield* presence.upsert({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        actor: organizationActor,
        status: "controlling",
        now,
        expiresAt: presenceExpiresAt,
      })

      yield* Effect.tryPromise(() => db.delete(identityMember).where(eq(identityMember.id, membershipId)))

      const authorityRecords = yield* Effect.tryPromise(() =>
        db
          .select({
            ownerId: rikaHostedClientAuthorities.ownerId,
            revokedAt: rikaHostedClientAuthorities.revokedAt,
          })
          .from(rikaHostedClientAuthorities)
          .where(eq(rikaHostedClientAuthorities.clientId, clientId))
          .orderBy(rikaHostedClientAuthorities.ownerId),
      )
      expect(
        authorityRecords.map(({ ownerId: recordOwnerId, revokedAt }) => ({
          ownerId: recordOwnerId,
          revoked: revokedAt !== null,
        })),
      ).toEqual([
        { ownerId: organizationOwnerId, revoked: true },
        { ownerId, revoked: false },
      ])
      expect(
        yield* protocol
          .replay({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            actor: organizationActor,
            afterCursor: ThreadEventCursor.make("0"),
            limit: 100,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })
      expect(
        yield* protocol
          .admitCommand({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            commandId: CommandId.make("revoked-command"),
            turnId: TurnId.make("turn-revoked-command"),
            idempotencyKey: IdempotencyKey.make("revoked-command-key"),
            expectedThreadVersion: ThreadVersion.make("1"),
            actor: organizationActor,
            command: { _tag: "Cancel" },
            admittedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })
      expect(
        yield* presence
          .list({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            actor: organizationActor,
            now: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })

      const personalReplay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(personalReplay).toMatchObject({
        threadVersion: "0",
        cursor: "0",
      })
      yield* presence.upsert({
        ownerId,
        threadId,
        actor,
        status: "viewing",
        now: later,
        expiresAt: presenceExpiresAt,
      })
      expect(yield* presence.list({ ownerId, threadId, actor, now: later })).toHaveLength(1)
    }),
  ),
)
