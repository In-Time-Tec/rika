import { RepositoryCheckout, WorkspaceSeed } from "@rika/product/executor-assignment"
import { identityMember } from "@rika/identity"
import { and, eq, sql } from "drizzle-orm"
import {
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjectGrants,
  rikaHostedRunnerRegistrations,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaHostedWorkspaceSeeds,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "../../database/schema/product"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { ProductRepositoryError, type ProductRepositoryService } from "./contract"

const databaseError = (cause: unknown) => ProductRepositoryError.make({ kind: "unavailable", message: String(cause) })
const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(databaseError))

const every = (...conditions: ReadonlyArray<boolean>) => conditions.every(Boolean)
const RunnerPlacement = Schema.TaggedStruct("RunnerPlacement", {
  deviceId: Schema.String,
  checkoutFingerprint: Schema.String,
  requestingDeviceId: Schema.String,
})

export const threadOperations = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const existingConnection: ProductRepositoryService["existingConnection"] = (input) =>
    query(
      db
        .select({
          archiveSourceThreadId: rikaHostedThreads.archiveSourceThreadId,
          ownerId: rikaHostedThreads.ownerId,
          projectId: rikaHostedThreads.projectId,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          placement: rikaHostedExecutorAssignments.placement,
          workspaceSeed: rikaHostedExecutorAssignments.workspaceSeed,
        })
        .from(rikaHostedThreads)
        .innerJoin(rikaHostedExecutorAssignments, eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id))
        .where(eq(rikaHostedThreads.id, input.threadId))
        .limit(1),
    ).pipe(
      Effect.map((rows) => {
        const existing = rows[0]
        if (existing === undefined) return undefined
        const placement = Schema.decodeUnknownOption(RunnerPlacement)(existing.placement)
        const runnerCompatible =
          input.runnerTarget === undefined ||
          (placement._tag === "Some" &&
            placement.value.deviceId === input.runnerTarget.deviceId &&
            placement.value.checkoutFingerprint === input.runnerTarget.checkoutFingerprint)
        const seed = Schema.decodeUnknownOption(WorkspaceSeed)(existing.workspaceSeed)
        const seedCompatible =
          input.workspaceSeedId === undefined
            ? existing.workspaceSeed === null
            : seed._tag === "Some" && seed.value.id === input.workspaceSeedId
        return existing.ownerId === input.authority.ownerId &&
          existing.archiveSourceThreadId === (input.archiveThreadId ?? null) &&
          existing.projectId === input.projectId &&
          existing.createdByUserId === input.authority.userId &&
          existing.executorKind === input.executorKind &&
          runnerCompatible &&
          seedCompatible
          ? { _tag: "Existing" as const, threadId: input.threadId }
          : { _tag: "Incompatible" as const }
      }),
    )

  const createConnection: ProductRepositoryService["createConnection"] = (input) => {
    if (input.archiveThreadId === input.threadId)
      return Effect.fail(
        ProductRepositoryError.make({
          kind: "conflict",
          message: "A replacement Thread cannot archive itself",
        }),
      )
    return db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.threadId}, 0))`)
            .pipe(Effect.mapError(databaseError))
          let workspaceId = input.workspaceId
          const existing = (yield* query(
            tx
              .select({
                archiveSourceThreadId: rikaHostedThreads.archiveSourceThreadId,
                ownerId: rikaHostedThreads.ownerId,
                projectId: rikaHostedThreads.projectId,
                createdByUserId: rikaHostedThreads.createdByUserId,
                executorKind: rikaHostedThreads.executorKind,
                placement: rikaHostedExecutorAssignments.placement,
                workspaceSeed: rikaHostedExecutorAssignments.workspaceSeed,
              })
              .from(rikaHostedThreads)
              .innerJoin(
                rikaHostedExecutorAssignments,
                eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id),
              )
              .where(eq(rikaHostedThreads.id, input.threadId))
              .limit(1),
          ))[0]
          const existingResult = (() => {
            if (existing === undefined) return undefined
            const placement = Schema.decodeUnknownOption(RunnerPlacement)(existing.placement)
            const runnerCompatible =
              input.runnerTarget === undefined ||
              every(
                placement._tag === "Some",
                placement._tag === "Some" && placement.value.deviceId === input.runnerTarget.deviceId,
                placement._tag === "Some" &&
                  placement.value.checkoutFingerprint === input.runnerTarget.checkoutFingerprint,
              )
            const seed = Schema.decodeUnknownOption(WorkspaceSeed)(existing.workspaceSeed)
            const seedCompatible =
              input.workspaceSeedId === undefined
                ? existing.workspaceSeed === null
                : every(seed._tag === "Some", seed._tag === "Some" && seed.value.id === input.workspaceSeedId)
            return every(
              existing.ownerId === input.authority.ownerId,
              existing.archiveSourceThreadId === (input.archiveThreadId ?? null),
              existing.projectId === input.projectId,
              existing.createdByUserId === input.authority.userId,
              existing.executorKind === input.executorKind,
              runnerCompatible,
              seedCompatible,
            )
              ? { _tag: "Existing" as const, threadId: input.threadId }
              : { _tag: "Incompatible" as const }
          })()
          if (existingResult !== undefined) return existingResult
          if (input.archiveThreadId !== undefined) {
            const source = yield* query(
              tx
                .select({ id: rikaThreads.id })
                .from(rikaThreads)
                .where(and(eq(rikaThreads.id, input.archiveThreadId), eq(rikaThreads.ownerId, input.authority.ownerId)))
                .for("update")
                .limit(1),
            )
            if (source[0] === undefined)
              return yield* ProductRepositoryError.make({
                kind: "not-found",
                message: "Thread is unavailable",
              })
          }
          if (input.runnerTarget !== undefined) {
            const runner = (yield* query(
              tx
                .select({
                  workspaceId: rikaHostedRunnerRegistrations.workspaceId,
                  projectId: rikaHostedRunnerRegistrations.projectId,
                  userId: rikaHostedRunnerRegistrations.userId,
                  allowed: rikaHostedRunnerRegistrations.remoteThreadCreationAllowed,
                })
                .from(rikaHostedRunnerRegistrations)
                .where(
                  and(
                    eq(rikaHostedRunnerRegistrations.deviceId, input.runnerTarget.deviceId),
                    eq(rikaHostedRunnerRegistrations.checkoutFingerprint, input.runnerTarget.checkoutFingerprint),
                  ),
                )
                .for("update")
                .limit(1),
            ))[0]
            if (runner === undefined) return { _tag: "RunnerMissing" as const }
            if (!every(runner.userId === input.authority.userId, runner.projectId === input.projectId))
              return { _tag: "RunnerAuthorityMismatch" as const }
            if (every(input.requestingDeviceId !== input.runnerTarget.deviceId, !runner.allowed))
              return { _tag: "RunnerRemoteDenied" as const }
            workspaceId = runner.workspaceId
          }
          const loadWorkspaceSeed = Effect.gen(function* () {
            if (input.workspaceSeedId === undefined) return null
            if (input.executorKind !== "orb")
              return yield* ProductRepositoryError.make({
                kind: "conflict",
                message: "Workspace seed requires Orb execution",
              })
            const staged = (yield* query(
              tx
                .select({
                  userId: rikaHostedWorkspaceSeeds.createdByUserId,
                  deviceId: rikaHostedWorkspaceSeeds.createdByDeviceId,
                  clientId: rikaHostedWorkspaceSeeds.createdByClientId,
                  manifest: rikaHostedWorkspaceSeeds.manifest,
                  claimedAssignmentId: rikaHostedWorkspaceSeeds.claimedAssignmentId,
                  expiresAt: rikaHostedWorkspaceSeeds.expiresAt,
                })
                .from(rikaHostedWorkspaceSeeds)
                .where(eq(rikaHostedWorkspaceSeeds.id, input.workspaceSeedId))
                .for("update")
                .limit(1),
            ))[0]
            if (staged === undefined || staged.expiresAt <= input.now)
              return yield* ProductRepositoryError.make({ kind: "not-found", message: "Workspace seed is unavailable" })
            if (
              !every(
                staged.userId === input.authority.userId,
                staged.deviceId === input.requestingDeviceId,
                staged.clientId === input.requestingClientId,
              )
            )
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Workspace seed is unavailable" })
            if (every(staged.claimedAssignmentId !== null, staged.claimedAssignmentId !== input.assignmentId))
              return yield* ProductRepositoryError.make({
                kind: "conflict",
                message: "Workspace seed was already claimed",
              })
            const seed = yield* Schema.decodeUnknownEffect(WorkspaceSeed)(staged.manifest).pipe(
              Effect.mapError(() => databaseError("Workspace seed manifest is invalid")),
            )
            if (input.checkout !== null) {
              const checkout = yield* Schema.decodeUnknownEffect(RepositoryCheckout)(input.checkout).pipe(
                Effect.mapError(() => databaseError("Repository checkout is invalid")),
              )
              if (
                !every(
                  seed.sourceRepository !== null,
                  seed.sourceRepository !== null &&
                    seed.sourceRepository.owner.toLowerCase() === checkout.owner.toLowerCase(),
                  seed.sourceRepository !== null &&
                    seed.sourceRepository.name.toLowerCase() === checkout.name.toLowerCase(),
                )
              )
                return yield* ProductRepositoryError.make({
                  kind: "conflict",
                  message: "Local Workspace repository does not match the selected Project repository",
                })
            }
            return seed
          })
          const workspaceSeed = yield* loadWorkspaceSeed
          const inheritProjectGrants = input.executorKind === "orb" && input.projectId !== null
          yield* query(
            tx
              .insert(rikaHostedWorkspaces)
              .values({
                id: workspaceId,
                ownerId: input.authority.ownerId,
                projectId: input.projectId,
                createdByUserId: input.authority.userId,
                executorKind: input.executorKind,
                inheritProjectGrants,
                createdAt: input.now,
              })
              .onConflictDoNothing()
              .returning({ id: rikaHostedWorkspaces.id }),
          )
          yield* query(
            tx
              .insert(rikaWorkspaces)
              .values({ ownerId: input.authority.ownerId, path: workspaceId, createdAt: input.nowMillis })
              .onConflictDoNothing()
              .returning({ path: rikaWorkspaces.path }),
          )
          yield* query(
            tx
              .insert(rikaHostedThreads)
              .values({
                id: input.threadId,
                archiveSourceThreadId: input.archiveThreadId ?? null,
                ownerId: input.authority.ownerId,
                projectId: input.projectId,
                workspaceId,
                createdByUserId: input.authority.userId,
                executorKind: input.executorKind,
                inheritProjectGrants,
                createdAt: input.now,
              })
              .returning({ id: rikaHostedThreads.id }),
          )
          yield* query(
            tx
              .insert(rikaThreads)
              .values({
                id: input.threadId,
                ownerId: input.authority.ownerId,
                workspace: workspaceId,
                title: "New thread",
                createdAt: input.nowMillis,
                updatedAt: input.nowMillis,
              })
              .returning({ id: rikaThreads.id }),
          )
          if (
            input.authority.owner._tag === "OrganizationOwner" &&
            input.projectId === null &&
            input.authority.membershipId !== undefined
          )
            yield* query(
              tx
                .insert(rikaHostedThreadGrants)
                .values({
                  ownerId: input.authority.ownerId,
                  threadId: input.threadId,
                  membershipId: input.authority.membershipId,
                  role: "owner",
                  grantedByUserId: input.authority.userId,
                  createdAt: input.now,
                  updatedAt: input.now,
                })
                .returning({ threadId: rikaHostedThreadGrants.threadId }),
            )
          yield* query(
            tx
              .insert(rikaHostedExecutorAssignments)
              .values({
                id: input.assignmentId,
                ownerId: input.authority.ownerId,
                threadId: input.threadId,
                workspaceId,
                executorKind: input.executorKind,
                placement: input.placement,
                checkout: input.checkout,
                workspaceSeed,
                generation: 1,
                revision: 0,
                lastLeaseEpoch: 0,
                lifecycle: "pending",
              })
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
          if (input.archiveThreadId !== undefined)
            yield* query(
              tx
                .update(rikaThreads)
                .set({ archived: 1, updatedAt: input.nowMillis })
                .where(and(eq(rikaThreads.id, input.archiveThreadId), eq(rikaThreads.ownerId, input.authority.ownerId)))
                .returning({ id: rikaThreads.id }),
            )
          if (input.workspaceSeedId !== undefined)
            yield* query(
              tx
                .update(rikaHostedWorkspaceSeeds)
                .set({ claimedAssignmentId: input.assignmentId })
                .where(eq(rikaHostedWorkspaceSeeds.id, input.workspaceSeedId))
                .returning({ id: rikaHostedWorkspaceSeeds.id }),
            )
          return { _tag: "Created" as const, threadId: input.threadId }
        }),
      )
      .pipe(Effect.mapError((error) => (Schema.is(ProductRepositoryError)(error) ? error : databaseError(error))))
  }

  const threadAuthority: ProductRepositoryService["threadAuthority"] = (userId, threadId) =>
    query(
      db
        .select({
          ownerId: rikaHostedThreads.ownerId,
          kind: rikaHostedOwners.kind,
          userId: rikaHostedOwners.userId,
          organizationId: rikaHostedOwners.organizationId,
          membershipId: identityMember.id,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
          threadRole: rikaHostedThreadGrants.role,
          projectRole: rikaHostedProjectGrants.role,
        })
        .from(rikaHostedThreads)
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreads.ownerId))
        .leftJoin(
          identityMember,
          and(eq(identityMember.organizationId, rikaHostedOwners.organizationId), eq(identityMember.userId, userId)),
        )
        .leftJoin(
          rikaHostedThreadGrants,
          and(
            eq(rikaHostedThreadGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedThreadGrants.threadId, rikaHostedThreads.id),
            eq(rikaHostedThreadGrants.membershipId, identityMember.id),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedThreads.projectId),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(eq(rikaHostedThreads.id, threadId))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]))

  const threadExecutionContext: ProductRepositoryService["threadExecutionContext"] = (ownerId, threadId) =>
    Effect.gen(function* () {
      const row = (yield* query(
        db
          .select({
            assignmentId: rikaHostedExecutorAssignments.id,
            workspaceId: rikaHostedExecutorAssignments.workspaceId,
            executorKind: rikaHostedExecutorAssignments.executorKind,
            generation: rikaHostedExecutorAssignments.generation,
            lifecycle: rikaHostedExecutorAssignments.lifecycle,
            executorInstanceId: rikaHostedExecutorAssignments.executorInstanceId,
            providerInstanceId: rikaHostedExecutorAssignments.providerInstanceId,
            checkout: rikaHostedExecutorAssignments.checkout,
            placement: rikaHostedExecutorAssignments.placement,
          })
          .from(rikaHostedExecutorAssignments)
          .where(
            and(
              eq(rikaHostedExecutorAssignments.ownerId, ownerId),
              eq(rikaHostedExecutorAssignments.threadId, threadId),
            ),
          )
          .limit(1),
      ))[0]
      if (row === undefined) return undefined
      let localRepository: Schema.Json = null
      const placement = Schema.decodeUnknownOption(RunnerPlacement)(row.placement)
      if (row.executorKind === "runner" && placement._tag === "Some") {
        const registrations = yield* query(
          db
            .select({ repository: rikaHostedRunnerRegistrations.repository })
            .from(rikaHostedRunnerRegistrations)
            .where(
              and(
                eq(rikaHostedRunnerRegistrations.deviceId, placement.value.deviceId),
                eq(rikaHostedRunnerRegistrations.checkoutFingerprint, placement.value.checkoutFingerprint),
              ),
            )
            .limit(1),
        )
        localRepository = yield* Schema.decodeUnknownEffect(Schema.Json)(registrations[0]?.repository ?? null).pipe(
          Effect.mapError(databaseError),
        )
      }
      return {
        assignmentId: row.assignmentId,
        workspaceId: row.workspaceId,
        executorKind: row.executorKind,
        generation: String(row.generation),
        lifecycle: row.lifecycle,
        executorInstanceId: row.executorInstanceId,
        providerInstanceId: row.providerInstanceId,
        checkout: row.checkout,
        localRepository,
      }
    })

  return { existingConnection, createConnection, threadAuthority, threadExecutionContext }
})
