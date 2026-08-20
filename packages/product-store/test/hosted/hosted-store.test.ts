import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  OrganizationId,
  OwnerId,
  ProjectId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import { layer } from "../../src/hosted/memory-store"

const now = Timestamp.make("2026-01-01T00:00:00.000Z")
const later = Timestamp.make("2026-01-01T00:01:00.000Z")
const userId = BetterAuthUserId.make("user")
const deviceId = DeviceId.make("device")
const clientId = ClientId.make("client")
const personalOwnerId = OwnerId.make("personal-owner")
const organizationOwnerId = OwnerId.make("organization-owner")
const personal = { _tag: "PersonalOwner" as const, userId }
const organization = {
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make("organization"),
}

it.layer(layer)("hosted memory store owner identity", (test) => {
  test.effect("creates personal projectless workspaces and threads", () =>
    Effect.gen(function* () {
      const store = yield* HostedStore
      yield* store.putOwner({ id: personalOwnerId, identity: personal, now })
      yield* store.registerDevice({
        id: deviceId,
        userId,
        displayName: "Laptop",
        publicKeyFingerprint: "sha256:laptop",
        now,
      })
      yield* store.authenticateClient({ id: clientId, userId, deviceId, now, expiresAt: later })
      const workspace = yield* store.createWorkspace({
        id: WorkspaceId.make("personal-workspace"),
        ownerId: personalOwnerId,
        createdByUserId: userId,
        executorKind: "local_device",
        now,
      })
      const thread = yield* store.createThread({
        id: ThreadId.make("personal-thread"),
        ownerId: personalOwnerId,
        workspaceId: workspace.id,
        createdByUserId: userId,
        executorKind: "local_device",
        now,
      })
      expect(workspace.projectId).toBeUndefined()
      expect(thread.projectId).toBeUndefined()
      expect(thread.ownerId).toBe(personalOwnerId)
      expect(
        yield* Effect.result(
          store.putThreadGrant({
            ownerId: personalOwnerId,
            threadId: thread.id,
            membershipId: BetterAuthMemberId.make("member"),
            role: "viewer",
            grantedByUserId: userId,
            now,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
    }),
  )

  test.effect("supports organization resources and grants", () =>
    Effect.gen(function* () {
      const store = yield* HostedStore
      yield* store.putOwner({ id: organizationOwnerId, identity: organization, now })
      const project = yield* store.createProject({
        id: ProjectId.make("organization-project"),
        ownerId: organizationOwnerId,
        name: "Rika",
        createdByUserId: userId,
        now,
      })
      const grant = yield* store.putProjectGrant({
        ownerId: organizationOwnerId,
        projectId: project.id,
        membershipId: BetterAuthMemberId.make("member"),
        role: "controller",
        grantedByUserId: userId,
        now,
      })
      expect(grant).toMatchObject({ ownerId: organizationOwnerId, role: "controller" })
    }),
  )

  test.effect("keeps owner IDs stable and rejects foreign projects", () =>
    Effect.gen(function* () {
      const store = yield* HostedStore
      const first = yield* store.putOwner({ id: personalOwnerId, identity: personal, now })
      expect(yield* store.putOwner({ id: personalOwnerId, identity: personal, now: later })).toEqual(first)
      expect(
        yield* Effect.result(store.putOwner({ id: personalOwnerId, identity: organization, now: later })),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
      expect(
        yield* Effect.result(
          store.putOwner({ id: OwnerId.make("another-personal-owner"), identity: personal, now: later }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })

      yield* store.putOwner({ id: organizationOwnerId, identity: organization, now })
      const project = yield* store.createProject({
        id: ProjectId.make("foreign-project"),
        ownerId: organizationOwnerId,
        name: "Foreign",
        createdByUserId: userId,
        now,
      })
      expect(
        yield* Effect.result(
          store.createWorkspace({
            id: WorkspaceId.make("foreign-workspace"),
            ownerId: personalOwnerId,
            projectId: project.id,
            createdByUserId: userId,
            executorKind: "e2b",
            now,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "not-found" } })
    }),
  )
})
