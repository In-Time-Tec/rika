import {
  expect,
  it,
  identityMember,
  identityOrganization,
  identityUser,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  asc,
  eq,
  DateTime,
  Effect,
  HostedProduct,
  live,
  principal,
  personal,
  organization,
  failureKind,
  hostedProductFixture,
} from "./fixture"

const { withDatabase } = hostedProductFixture

it.effect.skipIf(!live)("revokes organization admission immediately without affecting personal threads", () =>
  withDatabase("revocation", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "member-user",
          name: "member-user",
          email: "member-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "revoked-org", name: "revoked-org", slug: "revoked-org", createdAt }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values({
          id: "revoked-membership",
          organizationId: "revoked-org",
          userId: "member-user",
          role: "member",
          createdAt,
        }),
      )
      const product = yield* HostedProduct
      const personalConnection = yield* product.createConnection({
        principal: principal("member-user"),
        owner: personal("member-user"),
        executorKind: "orb",
      })
      const organizationConnection = yield* product.createConnection({
        principal: principal("member-user"),
        owner: organization("revoked-org"),
        executorKind: "orb",
      })
      yield* product.authorizeReadThread({ userId: "member-user" }, organizationConnection.threadId)
      yield* product.authorizeReadThread({ userId: "member-user" }, personalConnection.threadId)
      expect(
        yield* failureKind(product.authorizeReadThread({ userId: "foreign-user" }, personalConnection.threadId)),
      ).toBe("forbidden")
      yield* product.admitRun({
        principal: principal("member-user"),
        threadId: organizationConnection.threadId,
        operationKey: "org-before-revocation",
        prompt: "allowed",
      })
      yield* Effect.tryPromise(() => database.delete(identityMember).where(eq(identityMember.id, "revoked-membership")))
      expect(
        yield* failureKind(product.authorizeReadThread({ userId: "member-user" }, organizationConnection.threadId)),
      ).toBe("forbidden")
      yield* product.authorizeReadThread({ userId: "member-user" }, personalConnection.threadId)
      expect(
        yield* failureKind(
          product.admitRun({
            principal: principal("member-user"),
            threadId: organizationConnection.threadId,
            operationKey: "org-after-revocation",
            prompt: "denied",
            review: true,
          }),
        ),
      ).toBe("forbidden")
      yield* product.admitRun({
        principal: principal("member-user"),
        threadId: personalConnection.threadId,
        operationKey: "personal-after-revocation",
        prompt: "still allowed",
      })
    }),
  ),
)

it.effect.skipIf(!live)("requires a direct grant for a non-creator organization projectless thread", () =>
  withDatabase("grant", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values([
          {
            id: "creator-user",
            name: "creator-user",
            email: "creator-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: "operator-user",
            name: "operator-user",
            email: "operator-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
        ]),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "grant-org", name: "grant-org", slug: "grant-org", createdAt }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values([
          {
            id: "creator-membership",
            organizationId: "grant-org",
            userId: "creator-user",
            role: "member",
            createdAt,
          },
          {
            id: "operator-membership",
            organizationId: "grant-org",
            userId: "operator-user",
            role: "member",
            createdAt,
          },
        ]),
      )
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: principal("creator-user"),
        owner: organization("grant-org"),
        executorKind: "orb",
      })
      const operate = product.admitRun({
        principal: principal("operator-user"),
        threadId: connection.threadId,
        operationKey: "operator-run",
        prompt: "operate",
      })
      const read = product.authorizeReadThread({ userId: "operator-user" }, connection.threadId)
      expect(yield* failureKind(read)).toBe("forbidden")
      expect(yield* failureKind(operate)).toBe("forbidden")
      const owners = yield* Effect.tryPromise(() =>
        database
          .select({ owner_id: rikaHostedThreads.ownerId })
          .from(rikaHostedThreads)
          .where(eq(rikaHostedThreads.id, connection.threadId)),
      )
      const owner = owners[0]
      if (owner === undefined) return yield* Effect.die("Organization Thread owner was not persisted")
      yield* Effect.tryPromise(() =>
        database.insert(rikaHostedThreadGrants).values({
          ownerId: owner.owner_id,
          threadId: connection.threadId,
          membershipId: "operator-membership",
          role: "operator",
          grantedByUserId: "creator-user",
          createdAt,
          updatedAt: createdAt,
        }),
      )
      yield* read
      yield* operate
      const commands = yield* Effect.tryPromise(() =>
        database
          .select({ actor: rikaHostedThreadProtocolCommands.actor })
          .from(rikaHostedThreadProtocolCommands)
          .where(eq(rikaHostedThreadProtocolCommands.commandId, "operator-run")),
      )
      expect(commands[0]?.actor).toMatchObject({
        _tag: "OrganizationActor",
        userId: "operator-user",
        membershipId: "operator-membership",
        owner: organization("grant-org"),
      })
      yield* Effect.tryPromise(() =>
        database.delete(rikaHostedThreadGrants).where(eq(rikaHostedThreadGrants.threadId, connection.threadId)),
      )
      expect(yield* failureKind(read)).toBe("forbidden")
    }),
  ),
)

it.effect.skipIf(!live)("fails closed for forged and cross-owner selections", () =>
  withDatabase("forgery", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values([
          {
            id: "first-user",
            name: "first-user",
            email: "first-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: "second-user",
            name: "second-user",
            email: "second-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
        ]),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "foreign-org", name: "foreign-org", slug: "foreign-org", createdAt }),
      )
      const product = yield* HostedProduct
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: personal("second-user"),
            executorKind: "orb",
          }),
        ),
      ).toBe("forbidden")
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: organization("foreign-org"),
            executorKind: "orb",
          }),
        ),
      ).toBe("forbidden")
      const secondConnection = yield* product.createConnection({
        principal: principal("second-user"),
        owner: personal("second-user"),
        executorKind: "orb",
      })
      expect(
        yield* failureKind(
          product.admitRun({
            principal: principal("first-user"),
            threadId: secondConnection.threadId,
            operationKey: "foreign-thread",
            prompt: "denied",
          }),
        ),
      ).toBe("forbidden")
      yield* product.projects(principal("first-user"))
      const secondOwners = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id })
          .from(rikaHostedOwners)
          .where(eq(rikaHostedOwners.userId, "second-user")),
      )
      const secondOwner = secondOwners[0]
      if (secondOwner === undefined) return yield* Effect.die("Second personal owner was not persisted")
      yield* Effect.tryPromise(() =>
        database.insert(rikaHostedProjects).values({
          id: "foreign-project",
          ownerId: secondOwner.id,
          name: "Foreign",
          createdByUserId: "second-user",
          createdAt,
          updatedAt: createdAt,
        }),
      )
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: personal("first-user"),
            projectId: "foreign-project",
            executorKind: "orb",
          }),
        ),
      ).toBe("not-found")
    }),
  ),
)

it.effect.skipIf(!live)("provisions stable opaque personal and organization owners under concurrency", () =>
  withDatabase("owners", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "owner-user",
          name: "owner-user",
          email: "owner-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "owner-org", name: "owner-org", slug: "owner-org", createdAt }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values({
          id: "owner-membership",
          organizationId: "owner-org",
          userId: "owner-user",
          role: "member",
          createdAt,
        }),
      )
      const product = yield* HostedProduct
      yield* Effect.all(
        Array.from({ length: 8 }, () => product.projects(principal("owner-user"))),
        {
          concurrency: "unbounded",
        },
      )
      const owners = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id, kind: rikaHostedOwners.kind })
          .from(rikaHostedOwners)
          .orderBy(asc(rikaHostedOwners.kind)),
      )
      expect(owners).toHaveLength(2)
      expect(owners.map(({ kind }) => kind).toSorted()).toEqual(["organization", "personal"])
      expect(owners.every(({ id }) => id !== "owner-user" && id !== "owner-org")).toBe(true)
      yield* product.projects(principal("owner-user"))
      const repeated = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id, kind: rikaHostedOwners.kind })
          .from(rikaHostedOwners)
          .orderBy(asc(rikaHostedOwners.kind)),
      )
      expect(repeated).toEqual(owners)
    }),
  ),
)
