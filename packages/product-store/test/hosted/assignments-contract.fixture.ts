import { expect, it } from "@effect/vitest"

import { AssignmentRevision } from "@rika/product/executor-assignment"
import type { ExecutorAssignment, WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { type Access, ExecutorAssignments } from "@rika/product/executor-assignments"
import {
  CheckpointId,
  DeviceId,
  ExecutorAssignmentId,
  Sequence,
  ThreadId,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { eq, sql as drizzleSql } from "drizzle-orm"
import { Effect, Layer, Redacted } from "effect"
import { identityMigrations } from "../../../identity/src/database/migrations"
import * as schema from "../../src/database/schema/product"
import { migrations } from "../../src/hosted/migrations"
import * as HostedPostgres from "../../src/hosted/layer"
import {
  apply,
  capabilities,
  ids,
  isolated,
  live,
  seedIdentity,
  seedRecoveryAggregate,
  version,
} from "./assignments.support"

it.effect.skipIf(!live)("enforces the executor assignment contract with PostgreSQL time and fences", () =>
  isolated(({ pool, database, effectDatabase, url }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      yield* seedIdentity(database)
      yield* seedRecoveryAggregate(effectDatabase)
      const suffixes = [
        "session",
        "checkpoint",
        "replacement",
        "authority",
        "capabilities",
        "no-checkout",
        "expired-bootstrap",
        "expired-lease",
      ] as const
      yield* effectDatabase.transaction((tx) =>
        Effect.forEach(
          suffixes,
          (suffix) =>
            Effect.gen(function* () {
              const now = drizzleSql`transaction_timestamp()`
              const workspaceId = `workspace-${suffix}`
              const threadId = `thread-${suffix}`
              yield* tx.insert(schema.rikaHostedWorkspaces).values({
                id: workspaceId,
                ownerId: ids.owner,
                projectId: null,
                createdByUserId: ids.user,
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              })
              yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: ids.owner, path: workspaceId, createdAt: 1 })
              yield* tx.insert(schema.rikaHostedThreads).values({
                id: threadId,
                ownerId: ids.owner,
                projectId: null,
                workspaceId,
                createdByUserId: ids.user,
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              })
              yield* tx.insert(schema.rikaThreads).values({
                id: threadId,
                ownerId: ids.owner,
                workspace: workspaceId,
                title: suffix,
                createdAt: 1,
                updatedAt: 1,
              })
            }),
          { discard: true },
        ),
      )

      const layer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          yield* Effect.gen(function* () {
            const assignments = yield* ExecutorAssignments
            const capabilitiesFor = (digestCharacter: string): WorkspaceCapabilitySnapshot => ({
              ...capabilities,
              environmentDigest: `sha256:${digestCharacter.repeat(64)}`,
            })
            const open = (suffix: (typeof suffixes)[number]) =>
              Effect.gen(function* () {
                const before = yield* Effect.tryPromise(() =>
                  pool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now"),
                )
                const created = yield* assignments.create({
                  id: ExecutorAssignmentId.make(`assignment-${suffix}`),
                  ownerId: ids.owner,
                  threadId: ThreadId.make(`thread-${suffix}`),
                  workspaceId: WorkspaceId.make(`workspace-${suffix}`),
                  placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
                  checkout: null,
                })
                const after = yield* Effect.tryPromise(() =>
                  pool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now"),
                )
                const createdAt = Date.parse(created.createdAt)
                expect(createdAt).toBeGreaterThanOrEqual(before.rows[0]!.now.getTime())
                expect(createdAt).toBeLessThanOrEqual(after.rows[0]!.now.getTime())
                const provisioning = yield* assignments.beginProvisioning({
                  ...version(created),
                  bootstrapCredentialDigest: Redacted.make("bootstrap"),
                  bootstrapLifetimeMillis: 60_000,
                })
                const bound = yield* assignments.bindProviderInstance({
                  ...version(provisioning),
                  providerInstanceId: `sandbox-${suffix}`,
                })
                const active = yield* assignments.openSession({
                  ...version(bound),
                  providerInstanceId: `sandbox-${suffix}`,
                  executorInstanceId: ids.executor,
                  processIncarnation: `process-${suffix}`,
                  capabilities: capabilitiesFor("a"),
                  presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
                  sessionCredentialDigest: Redacted.make("session"),
                  leaseLifetimeMillis: 60_000,
                })
                if (active.lifecycle._tag !== "Active") return yield* Effect.die("assignment did not become active")
                const access: Access = {
                  assignmentId: active.id,
                  assignmentGeneration: active.generation,
                  providerInstanceId: active.lifecycle.providerInstanceId,
                  executorInstanceId: active.lifecycle.executorInstanceId,
                  processIncarnation: active.lifecycle.processIncarnation,
                  leaseEpoch: active.lifecycle.leaseEpoch,
                  presentedSessionCredentialDigest: Redacted.make("session"),
                }
                return { bound, active, access }
              })

            const session = yield* open("session")
            expect(yield* assignments.getForThread(ThreadId.make("thread-session"))).toEqual(session.active)
            expect(session.active).not.toHaveProperty("bootstrapCredentialDigest")
            expect(session.active).not.toHaveProperty("sessionCredentialDigest")
            const bootstrapReplay = yield* Effect.result(
              assignments.openSession({
                ...version(session.active),
                providerInstanceId: "sandbox-session",
                executorInstanceId: ids.executor,
                processIncarnation: "process-session",
                capabilities: capabilitiesFor("b"),
                presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
                sessionCredentialDigest: Redacted.make("another-session"),
                leaseLifetimeMillis: 60_000,
              }),
            )
            expect(bootstrapReplay).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
            const reconnected = yield* assignments.reconnect({ access: session.access, leaseLifetimeMillis: 60_000 })
            expect(reconnected.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "2" })
            expect(yield* Effect.result(assignments.authenticate(session.access))).toMatchObject({
              _tag: "Failure",
              failure: { reason: "stale-fence" },
            })
            expect(AssignmentRevision.make(session.bound.revision)).toBe("2")

            const checkpointSession = yield* open("checkpoint")
            const cursor = { sequence: Sequence.make("1"), value: "event-1" }
            yield* assignments.heartbeat({ access: checkpointSession.access, cursor, leaseLifetimeMillis: 60_000 })
            const checkpointInput = {
              access: checkpointSession.access,
              id: CheckpointId.make("checkpoint-contract"),
              objectKey: "checkpoints/checkpoint.tar.zst",
              contentDigest: `sha256:${"a".repeat(64)}`,
              sizeBytes: 1024,
              format: "tar.zst" as const,
              cursor,
              metadata: { source: "filesystem" },
            }
            const checkpoint = yield* assignments.commitCheckpoint(checkpointInput)
            expect(yield* assignments.commitCheckpoint(checkpointInput)).toEqual(checkpoint)
            expect(yield* assignments.latestCheckpoint(checkpointSession.active.id)).toEqual(checkpoint)
            expect(
              yield* Effect.result(
                assignments.commitCheckpoint({ ...checkpointInput, sizeBytes: checkpointInput.sizeBytes + 1 }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
            expect(
              yield* Effect.result(
                assignments.heartbeat({
                  access: checkpointSession.access,
                  cursor: { sequence: Sequence.make("0"), value: "" },
                  leaseLifetimeMillis: 60_000,
                }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })

            const replacementSession = yield* open("replacement")
            if (replacementSession.active.placement._tag !== "OrbPlacement")
              return yield* Effect.die("assignment is not placed in an Orb")
            const replacement = yield* assignments.beginReplacement({
              ...version(replacementSession.active),
              placement: { ...replacementSession.active.placement, templateBuildId: "template-v2" },
              bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect(replacement).toMatchObject({
              generation: "2",
              capabilityGeneration: null,
              capabilities: null,
              lifecycle: { _tag: "Provisioning", providerInstanceId: null },
            })
            expect(yield* Effect.result(assignments.authenticate(replacementSession.access))).toMatchObject({
              _tag: "Failure",
              failure: { reason: "stale-fence" },
            })

            const authoritySession = yield* open("authority")
            const unauthorizedPlacements: ReadonlyArray<ExecutorAssignment["placement"]> = [
              { _tag: "OrbPlacement", templateBuildId: "template-v2", providerScope: "another-scope" },
              {
                _tag: "RunnerPlacement",
                deviceId: DeviceId.make("another-device"),
                checkoutFingerprint: CheckoutFingerprint.make("another-checkout"),
                requestingDeviceId: DeviceId.make("another-requester"),
              },
            ]
            for (const placement of unauthorizedPlacements)
              expect(
                yield* Effect.result(
                  assignments.beginReplacement({
                    ...version(authoritySession.active),
                    placement,
                    bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
                    bootstrapLifetimeMillis: 60_000,
                  }),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })

            const capabilitySession = yield* open("capabilities")
            const refreshedCapabilities = capabilitiesFor("c")
            const updated = yield* assignments.updateCapabilities({
              access: capabilitySession.access,
              capabilities: refreshedCapabilities,
            })
            expect(updated.capabilityGeneration).toBe(updated.generation)
            expect(updated.capabilities).toEqual(refreshedCapabilities)
            const paused = yield* assignments.pause(version(updated))
            expect(paused.capabilities).toEqual(refreshedCapabilities)
            const capabilityReplacement = yield* assignments.beginReplacement({
              ...version(paused),
              placement: paused.placement,
              bootstrapCredentialDigest: Redacted.make("replacement-capabilities"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect(capabilityReplacement).toMatchObject({ capabilityGeneration: null, capabilities: null })

            expect((yield* open("no-checkout")).active.checkout).toBeNull()

            const expiredBootstrapCreated = yield* assignments.create({
              id: ExecutorAssignmentId.make("assignment-expired-bootstrap"),
              ownerId: ids.owner,
              threadId: ThreadId.make("thread-expired-bootstrap"),
              workspaceId: WorkspaceId.make("workspace-expired-bootstrap"),
              placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
              checkout: null,
            })
            const expiredProvisioning = yield* assignments.beginProvisioning({
              ...version(expiredBootstrapCreated),
              bootstrapCredentialDigest: Redacted.make("expired-bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            const expiredBound = yield* assignments.bindProviderInstance({
              ...version(expiredProvisioning),
              providerInstanceId: "sandbox-expired",
            })
            yield* Effect.tryPromise(() =>
              database
                .update(schema.rikaHostedExecutorAssignments)
                .set({ bootstrapExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, expiredBound.id)),
            )
            expect(yield* assignments.isBootstrapLive(version(expiredBound))).toBe(false)
            expect(
              yield* Effect.result(
                assignments.openSession({
                  ...version(expiredBound),
                  providerInstanceId: "sandbox-expired",
                  executorInstanceId: ids.executor,
                  processIncarnation: "expired",
                  capabilities: capabilitiesFor("d"),
                  presentedBootstrapCredentialDigest: Redacted.make("expired-bootstrap"),
                  sessionCredentialDigest: Redacted.make("expired-session"),
                  leaseLifetimeMillis: 60_000,
                }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })

            const expiredLease = yield* open("expired-lease")
            yield* Effect.tryPromise(() =>
              database
                .update(schema.rikaHostedExecutorAssignments)
                .set({ leaseExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, expiredLease.active.id)),
            )
            expect(yield* Effect.result(assignments.authenticate(expiredLease.access))).toMatchObject({
              _tag: "Failure",
              failure: { reason: "stale-fence" },
            })
            const renewed = yield* assignments.reconnect({ access: expiredLease.access, leaseLifetimeMillis: 60_000 })
            expect(renewed.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "2" })
          }).pipe(Effect.provideContext(context))
        }),
      )
    }),
  ),
)
