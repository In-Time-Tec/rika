import { expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { identityMember, identityOrganization } from "@rika/identity"
import { ThreadId } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorAssignments,
  rikaHostedRunnerAdmissions,
  rikaHostedRunnerRegistrations,
  rikaHostedThreads,
  rikaHostedWorkspaceCapabilityAdmissions,
} from "@rika/product-store/database-schema"
import { emptyCursor } from "@rika/remote-execution/protocol"
import { and, count, eq, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Executor } from "../../src/executor/service"
import { HostedProduct } from "../../src/hosted/product"
import { RunnerExecutor } from "../../src/runner/executor"

import { executorFixture } from "./executor.fixture"
const {
  accessFrom,
  availableHostedEnvironment,
  failureKind,
  helloReadiness,
  isolated,
  live,
  localConnection,
  organization,
  personal,
  principal,
  seedPrincipal,
  unusedController,
} = executorFixture

it.effect.skipIf(!live)("keeps real personal local authority active without organization membership", () =>
  isolated("personal", (databaseClient) =>
    Effect.gen(function* () {
      const owner = principal("personal-user", "personal-client", "10000000-0000-4000-8000-000000000001")
      yield* seedPrincipal(databaseClient, owner)
      const authority = yield* RunnerExecutor
      const connection = yield* localConnection(owner, personal(owner.userId), "personal-workspace")
      const product = yield* HostedProduct
      const threadAuthority = yield* product.authorizeThread(owner, connection.threadId, "thread:view")
      const context = yield* product.threadExecutionContext(threadAuthority.ownerId, ThreadId.make(connection.threadId))
      expect(context).toMatchObject({
        repository: {
          identity: "repository-personal-workspace",
          branch: "main",
        },
        branch: "main",
        executor: { kind: "runner", generation: "1", lifecycle: "pending" },
      })
      expect(context.executor.assignmentId).not.toBe(connection.threadId)
      expect(yield* Effect.tryPromise(() => databaseClient.select({ count: count() }).from(identityMember))).toEqual([
        { count: 0 },
      ])
      const admission = yield* authority.admit({
        threadId: connection.threadId,
        workspaceFingerprint: connection.checkoutFingerprint,
        principal: owner,
        executorUrl: "ws://executor.test/local",
      })
      const workspace = yield* Effect.tryPromise(() =>
        databaseClient
          .select({ workspaceId: rikaHostedThreads.workspaceId })
          .from(rikaHostedThreads)
          .where(eq(rikaHostedThreads.id, connection.threadId)),
      )
      const workspaceRow = workspace[0]
      if (workspaceRow === undefined) return yield* Effect.die("Expected the personal thread workspace to exist")
      expect(admission.workspaceIdentity).toBe(workspaceRow.workspaceId)
      const welcome = yield* authority.hello({
        admissionId: admission.admissionId,
        ticket: admission.ticket,
        processIncarnation: "personal-process",
        ...helloReadiness,
      })
      const resume = yield* product.pollRunner({
        principal: owner,
        checkoutFingerprint: connection.checkoutFingerprint,
        supervisorId: "10000000-0000-4000-8000-000000000011",
        activeAssignmentIds: [],
      })
      expect(resume).toMatchObject({
        claimed: true,
        assignment: {
          assignmentId: admission.assignmentId,
          resume: true,
        },
      })
      expect(Number.isFinite(resume.assignment?.leaseExpiresAt)).toBe(true)
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [],
        }),
      ).toEqual({ claimed: false })
      const expiredSupervisorAt = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { seconds: 1 }))
      yield* Effect.tryPromise(() =>
        databaseClient.update(rikaHostedRunnerRegistrations).set({ supervisorExpiresAt: expiredSupervisorAt }),
      )
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [admission.assignmentId],
        }),
      ).toEqual({ claimed: true })
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [],
        }),
      ).toMatchObject({
        claimed: true,
        assignment: { assignmentId: admission.assignmentId, resume: true },
      })
      const access = accessFrom(welcome)
      yield* authority.validateAccess(access)
      expect(yield* authority.workspaceIdentity(access)).toBe(workspaceRow.workspaceId)
      const expiredLeaseAt = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { seconds: 1 }))
      yield* Effect.tryPromise(() =>
        databaseClient
          .update(rikaHostedExecutorAssignments)
          .set({ leaseExpiresAt: expiredLeaseAt })
          .where(eq(rikaHostedExecutorAssignments.id, admission.assignmentId)),
      )
      const reconnected = yield* authority.reconnect(access)
      expect(reconnected.leaseExpiresAt).toBeGreaterThan(welcome.leaseExpiresAt)
      yield* authority.heartbeat({
        version: 1,
        access: { ...access, leaseEpoch: reconnected.leaseEpoch },
        cursor: reconnected.cursor,
      })
      const admitted = yield* product.admitRun({
        principal: owner,
        threadId: connection.threadId,
        operationKey: "personal-turn",
        prompt: "personal prompt",
      })
      if (admitted._tag !== "Admitted") return yield* Effect.die("Runner prompt was cancelled unexpectedly")
      yield* Executor.pipe(
        Effect.flatMap((executor) =>
          executor.admitRun({
            threadId: connection.threadId,
            turnId: admitted.turnId,
            workspaceId: workspaceRow.workspaceId,
          }),
        ),
      )
      expect(
        (yield* Effect.tryPromise(() =>
          databaseClient.select({ consumedAt: rikaHostedRunnerAdmissions.consumedAt }).from(rikaHostedRunnerAdmissions),
        )).map((row) => ({ consumed: row.consumedAt !== null })),
      ).toEqual([{ consumed: true }])
      expect(
        yield* Effect.tryPromise(() =>
          databaseClient
            .select({ required_capabilities: rikaHostedWorkspaceCapabilityAdmissions.requiredCapabilities })
            .from(rikaHostedWorkspaceCapabilityAdmissions)
            .where(eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, admitted.turnId)),
        ),
      ).toEqual([
        {
          required_capabilities: ["filesystem", "typescriptKernel", "git", "process", "workspaceLifecycle"],
        },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("leaves a blank Orb pending and provisions its first capability admission once", () => {
  let provisionCount = 0
  return isolated(
    "orb-provisioning-owner",
    (databaseClient) =>
      Effect.gen(function* () {
        const owner = principal("orb-user", "orb-client", "15000000-0000-4000-8000-000000000001")
        yield* seedPrincipal(databaseClient, owner)
        const product = yield* HostedProduct
        const connection = yield* product.createConnection({
          principal: owner,
          owner: personal(owner.userId),
          executorKind: "orb",
        })
        expect(provisionCount).toBe(0)
        const admitted = yield* product.admitRun({
          principal: owner,
          threadId: connection.threadId,
          operationKey: "orb-turn",
          prompt: "run in the Orb",
        })
        if (admitted._tag !== "Admitted") return yield* Effect.die("Orb prompt was cancelled unexpectedly")
        const assignment = (yield* Effect.tryPromise(() =>
          databaseClient
            .select({ id: rikaHostedExecutorAssignments.id, workspaceId: rikaHostedExecutorAssignments.workspaceId })
            .from(rikaHostedExecutorAssignments)
            .where(eq(rikaHostedExecutorAssignments.threadId, connection.threadId)),
        ))[0]
        if (assignment === undefined) return yield* Effect.die("Expected the Orb executor assignment to exist")
        const executor = yield* Executor
        yield* executor.admitRun({
          threadId: connection.threadId,
          turnId: admitted.turnId,
          workspaceId: assignment.workspaceId,
        })
        expect(provisionCount).toBe(1)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ count: count() })
              .from(rikaHostedWorkspaceCapabilityAdmissions)
              .where(
                and(
                  eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, connection.threadId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, admitted.turnId),
                ),
              ),
          ),
        ).toEqual([{ count: 1 }])
      }),
    (databaseClient) => ({
      environment: availableHostedEnvironment,
      controller: {
        ...unusedController,
        cleanupOrphans: Effect.succeed([]),
        provision: (assignmentId: string) =>
          Effect.gen(function* () {
            provisionCount += 1
            const activatedAt = yield* DateTime.now
            const activatedAtDate = DateTime.toDate(activatedAt)
            const rows = yield* Effect.tryPromise({
              try: () =>
                databaseClient
                  .update(rikaHostedExecutorAssignments)
                  .set({
                    revision: sql`${rikaHostedExecutorAssignments.revision} + 1`,
                    lastLeaseEpoch: 1,
                    lifecycle: "active",
                    providerInstanceId: "orb-sandbox",
                    executorInstanceId: "orb-executor",
                    processIncarnation: "orb-process",
                    sessionDigest: "orb-session-digest",
                    leaseEpoch: 1,
                    leaseExpiresAt: DateTime.toDate(DateTime.add(activatedAt, { minutes: 1 })),
                    capabilityGeneration: sql`${rikaHostedExecutorAssignments.generation}`,
                    capabilitySnapshot: helloReadiness.workspaceCapabilities,
                    lastActiveAt: activatedAtDate,
                    updatedAt: activatedAtDate,
                  })
                  .where(eq(rikaHostedExecutorAssignments.id, assignmentId))
                  .returning({
                    threadId: rikaHostedExecutorAssignments.threadId,
                    generation: rikaHostedExecutorAssignments.generation,
                  }),
              catch: (error) =>
                ControllerError.make({
                  kind: "repository",
                  message: `Could not activate fake Orb assignment: ${String(error)}`,
                }),
            })
            const row = rows[0]
            if (row === undefined) return yield* Effect.die(`Expected Orb assignment ${assignmentId} to be activated`)
            return {
              assignmentId,
              threadId: row.threadId,
              generation: row.generation,
              templateBuildId: "local-authority-live",
              sandboxId: "orb-sandbox",
              state: "running" as const,
              cursor: emptyCursor,
            }
          }),
      },
    }),
  )
})

it.effect.skipIf(!live)("fences organization access immediately while preserving a personal session", () =>
  isolated("membership", (databaseClient) =>
    Effect.gen(function* () {
      const owner = principal("shared-user", "shared-client", "20000000-0000-4000-8000-000000000002")
      yield* seedPrincipal(databaseClient, owner)
      const now = yield* DateTime.nowAsDate
      yield* Effect.tryPromise(() =>
        databaseClient
          .insert(identityOrganization)
          .values({ id: "local-org", name: "Local org", slug: "local-org", createdAt: now }),
      )
      yield* Effect.tryPromise(() =>
        databaseClient.insert(identityMember).values({
          id: "local-member",
          organizationId: "local-org",
          userId: owner.userId,
          role: "member",
          createdAt: now,
        }),
      )
      const authority = yield* RunnerExecutor
      const personalConnection = yield* localConnection(owner, personal(owner.userId), "personal-workspace")
      const organizationConnection = yield* localConnection(owner, organization("local-org"), "organization-workspace")
      const open = (connection: typeof personalConnection, label: string) =>
        Effect.gen(function* () {
          const admission = yield* authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: connection.checkoutFingerprint,
            principal: owner,
            executorUrl: "ws://executor.test/local",
          })
          return yield* authority.hello({
            admissionId: admission.admissionId,
            ticket: admission.ticket,
            processIncarnation: `${label}-process`,
            ...helloReadiness,
          })
        })
      const personalWelcome = yield* open(personalConnection, "personal")
      const organizationWelcome = yield* open(organizationConnection, "organization")
      const personalAccess = accessFrom(personalWelcome)
      const organizationAccess = accessFrom(organizationWelcome)
      yield* authority.validateAccess(organizationAccess)
      yield* Effect.tryPromise(() => databaseClient.delete(identityMember).where(eq(identityMember.id, "local-member")))
      for (const operation of [
        authority.validateAccess(organizationAccess),
        authority.reconnect(organizationAccess),
        authority.heartbeat({
          version: 1,
          access: organizationAccess,
          cursor: organizationWelcome.cursor,
        }),
      ]) {
        expect(["authentication", "fenced"]).toContain(yield* failureKind(operation))
      }
      yield* authority.validateAccess(personalAccess)
      const personalReconnect = yield* authority.reconnect(personalAccess)
      yield* authority.heartbeat({
        version: 1,
        access: {
          ...personalAccess,
          leaseEpoch: personalReconnect.leaseEpoch,
        },
        cursor: personalReconnect.cursor,
      })
    }),
  ),
)

it.effect.skipIf(!live)("rejects cross-owner and cross-device admissions before issuing usable tickets", () =>
  isolated("cross_binding", (databaseClient) =>
    Effect.gen(function* () {
      const owner = principal("owner-user", "owner-client", "30000000-0000-4000-8000-000000000003")
      const stranger = principal("stranger-user", "stranger-client", "40000000-0000-4000-8000-000000000004")
      const otherDevice = principal("owner-user", "other-client", "50000000-0000-4000-8000-000000000005")
      yield* seedPrincipal(databaseClient, owner)
      yield* seedPrincipal(databaseClient, stranger)
      yield* seedPrincipal(databaseClient, otherDevice)
      const authority = yield* RunnerExecutor
      const connection = yield* localConnection(owner, personal(owner.userId), "cross-owner")
      expect(
        yield* failureKind(
          authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: connection.checkoutFingerprint,
            principal: stranger,
            executorUrl: "ws://executor.test/local",
          }),
        ),
      ).toBe("fenced")
      expect(
        yield* failureKind(
          authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: connection.checkoutFingerprint,
            principal: otherDevice,
            executorUrl: "ws://executor.test/local",
          }),
        ),
      ).toBe("fenced")
      expect(
        yield* Effect.tryPromise(() => databaseClient.select({ count: count() }).from(rikaHostedRunnerAdmissions)),
      ).toEqual([{ count: 0 }])
    }),
  ),
)
