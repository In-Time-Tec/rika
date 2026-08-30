import {
  expect,
  it,
  identityMember,
  identityUser,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreads,
  rikaHostedWorkspaceSeeds,
  rikaThreadQueueState,
  rikaTurns,
  eq,
  DateTime,
  Effect,
  HostedProduct,
  live,
  principal,
  personal,
  failureKind,
  requireAdmitted,
  hostedProductFixture,
} from "./fixture"

const { withDatabase } = hostedProductFixture

it.effect.skipIf(!live)("claims one staged Workspace seed atomically with its Orb assignment", () =>
  withDatabase("workspace-seed", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("workspace-seed-user")
      const now = DateTime.nowUnsafe()
      const createdAt = DateTime.toDate(now)
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: authenticated.userId,
          name: authenticated.userId,
          email: `${authenticated.userId}@example.test`,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const manifest = {
        id: "seed-1",
        sourceRepository: null,
        objectKey: "workspace-seeds/seed-1/source.tar.zst.aes",
        contentDigest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 128,
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 96,
        encryption: "aes-256-gcm",
      }
      yield* Effect.tryPromise(() =>
        database.insert(rikaHostedWorkspaceSeeds).values({
          id: manifest.id,
          createdByUserId: authenticated.userId,
          createdByDeviceId: authenticated.deviceId,
          createdByClientId: authenticated.clientId,
          manifest,
          expiresAt: DateTime.toDate(DateTime.add(now, { minutes: 10 })),
          createdAt,
        }),
      )
      const product = yield* HostedProduct
      const input = {
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb" as const,
        workspaceSeedId: manifest.id,
        threadId: "seeded-thread",
      }
      const created = yield* product.createConnection(input)
      expect(yield* product.createConnection(input)).toEqual(created)
      const [assignment] = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedExecutorAssignments.id, workspaceSeed: rikaHostedExecutorAssignments.workspaceSeed })
          .from(rikaHostedExecutorAssignments)
          .where(eq(rikaHostedExecutorAssignments.threadId, created.threadId)),
      )
      const [seed] = yield* Effect.tryPromise(() =>
        database
          .select({ claimedAssignmentId: rikaHostedWorkspaceSeeds.claimedAssignmentId })
          .from(rikaHostedWorkspaceSeeds)
          .where(eq(rikaHostedWorkspaceSeeds.id, manifest.id)),
      )
      expect(assignment?.workspaceSeed).toEqual(manifest)
      expect(seed?.claimedAssignmentId).toBe(assignment?.id)
      expect(
        yield* failureKind(
          product.createConnection({
            ...input,
            threadId: "another-seeded-thread",
          }),
        ),
      ).toBe("conflict")
    }),
  ),
)

it.effect.skipIf(!live)("supports a projectless personal connection for a user with no organizations", () =>
  withDatabase("personal", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "personal-user",
          name: "personal-user",
          email: "personal-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      expect(yield* product.projects(principal("personal-user"))).toEqual([])
      const connection = yield* product.createConnection({
        principal: principal("personal-user"),
        owner: personal("personal-user"),
        executorKind: "orb",
      })
      const admissionInput = {
        principal: principal("personal-user"),
        threadId: connection.threadId,
        operationKey: "personal-operation",
        prompt: "personal prompt",
      } as const
      const admitted = yield* requireAdmitted(product.admitRun(admissionInput))
      expect(admitted.status).toBe("accepted")
      expect(yield* product.admitRun(admissionInput)).toEqual(admitted)
      expect(yield* failureKind(product.admitRun({ ...admissionInput, prompt: "different prompt" }))).toBe("conflict")
      expect(yield* failureKind(product.admitRun({ ...admissionInput, mode: "low" }))).toBe("conflict")
      const facts = yield* Effect.tryPromise(() =>
        database
          .select({
            owner_id: rikaHostedOwners.id,
            user_id: rikaHostedOwners.userId,
            created_by_user_id: rikaHostedThreads.createdByUserId,
            assignment_id: rikaHostedExecutorAssignments.id,
            actor: rikaHostedThreadProtocolCommands.actor,
            turn_id: rikaHostedThreadProtocolCommands.turnId,
            status: rikaTurns.status,
            prompt: rikaTurns.prompt,
            memberships: database.$count(identityMember, eq(identityMember.userId, "personal-user")),
            turn_count: database.$count(rikaTurns, eq(rikaTurns.threadId, rikaHostedThreads.id)),
            queued_count: rikaThreadQueueState.queuedCount,
          })
          .from(rikaHostedThreadProtocolCommands)
          .innerJoin(rikaHostedThreads, eq(rikaHostedThreads.id, rikaHostedThreadProtocolCommands.threadId))
          .innerJoin(rikaHostedExecutorAssignments, eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id))
          .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreadProtocolCommands.ownerId))
          .innerJoin(rikaTurns, eq(rikaTurns.id, rikaHostedThreadProtocolCommands.turnId))
          .innerJoin(rikaThreadQueueState, eq(rikaThreadQueueState.threadId, rikaHostedThreads.id)),
      )
      expect(facts).toHaveLength(1)
      expect(facts[0]?.assignment_id).not.toBe(connection.threadId)
      expect(facts[0]).toMatchObject({
        user_id: "personal-user",
        created_by_user_id: "personal-user",
        memberships: 0,
        turn_id: admitted.turnId,
        status: "accepted",
        prompt: "personal prompt",
        turn_count: 1,
        queued_count: 0,
        actor: {
          _tag: "PersonalActor",
          userId: "personal-user",
          owner: personal("personal-user"),
        },
      })
      const queued = yield* requireAdmitted(
        product.admitRun({
          ...admissionInput,
          operationKey: "personal-operation-queued",
          prompt: "queued prompt",
        }),
      )
      expect(queued.status).toBe("queued")
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ id: rikaTurns.id, status: rikaTurns.status, queued_count: rikaThreadQueueState.queuedCount })
            .from(rikaTurns)
            .innerJoin(rikaThreadQueueState, eq(rikaThreadQueueState.threadId, rikaTurns.threadId))
            .where(eq(rikaTurns.id, queued.turnId)),
        ),
      ).toMatchObject([{ id: queued.turnId, status: "queued", queued_count: 1 }])
    }),
  ),
)
