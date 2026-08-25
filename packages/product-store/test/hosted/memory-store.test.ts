import { expect, it } from "@effect/vitest"

import { Effect } from "effect"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
  CommitCursor,
  DeviceId,
  IdempotencyKey,
  OrganizationId,
  OwnerId,
  ProjectId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { TurnId } from "@rika/product/turn-record"
import { layer } from "../../src/hosted/memory-store"

const now = Timestamp.make("2026-01-01T00:00:00.000Z")
const later = Timestamp.make("2026-01-01T00:01:00.000Z")
const userId = BetterAuthUserId.make("user")
const deviceId = DeviceId.make("device")
const clientId = ClientId.make("client")
const personalOwnerId = OwnerId.make("personal-owner")
const organizationOwnerId = OwnerId.make("organization-owner")
const personal = { _tag: "PersonalOwner" as const, userId }
const personalActor = { _tag: "PersonalActor" as const, owner: personal, userId, clientId, deviceId }
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
      expect(
        yield* store
          .authenticateClient({
            id: clientId,
            userId,
            deviceId,
            now,
            expiresAt: Timestamp.make("2026-01-01T00:05:01.000Z"),
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
      yield* store.authenticateClient({
        id: clientId,
        userId,
        deviceId,
        now,
        expiresAt: later,
      })
      yield* store.grantClientAuthority({
        ownerId: personalOwnerId,
        actor: personalActor,
        now,
        expiresAt: later,
      })
      const workspace = yield* store.createWorkspace({
        id: WorkspaceId.make("personal-workspace"),
        ownerId: personalOwnerId,
        createdByUserId: userId,
        executorKind: "runner",
        now,
      })
      const thread = yield* store.createThread({
        id: ThreadId.make("personal-thread"),
        ownerId: personalOwnerId,
        workspaceId: workspace.id,
        createdByUserId: userId,
        executorKind: "runner",
        now,
      })
      expect(workspace.projectId).toBeUndefined()
      expect(thread.projectId).toBeUndefined()
      expect(thread.ownerId).toBe(personalOwnerId)
      expect(yield* store.readThread({ ownerId: personalOwnerId, threadId: thread.id })).toEqual(thread)
      expect(yield* store.readThread({ ownerId: organizationOwnerId, threadId: thread.id })).toBeUndefined()
      yield* store.authorizeThread({
        ownerId: personalOwnerId,
        threadId: thread.id,
        actor: personalActor,
        action: "thread:control",
        at: now,
      })
      const prompt = {
        ownerId: personalOwnerId,
        threadId: thread.id,
        commandId: CommandId.make("prompt-command"),
        idempotencyKey: IdempotencyKey.make("prompt-key"),
        turnId: TurnId.make("prompt-turn"),
        actor: personalActor,
        prompt: "hello",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
        admittedAt: now,
        queueCapacity: 2,
      }
      expect(yield* Effect.result(store.admitPrompt({ ...prompt, readinessProof: false }))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "database" },
      })
      expect(
        yield* store.readCommands({
          ownerId: personalOwnerId,
          threadId: thread.id,
          actor: personalActor,
          afterCommitCursor: CommitCursor.make("0"),
          limit: 10,
        }),
      ).toEqual([])
      const admitted = yield* store.admitPrompt({ ...prompt, readinessProof: true })
      expect(admitted._tag).toBe("Admitted")
      if (admitted._tag !== "Admitted") return yield* Effect.die("Prompt was cancelled unexpectedly")
      expect(yield* store.admitPrompt({ ...prompt, readinessProof: false })).toEqual(admitted)
      const duplicates = yield* Effect.all(
        Array.from({ length: 8 }, () => store.admitPrompt({ ...prompt, readinessProof: true })),
        { concurrency: "unbounded" },
      )
      expect(
        duplicates.every(
          (duplicate) => duplicate._tag === "Admitted" && duplicate.command.commandId === admitted.command.commandId,
        ),
      ).toBe(true)
      const cancellation = {
        ownerId: personalOwnerId,
        threadId: thread.id,
        cancelCommandId: CommandId.make("cancel-before-admission"),
        targetCommandId: CommandId.make("cancelled-prompt-command"),
        actor: personalActor,
        cancelledAt: now,
      }
      expect(yield* store.cancelPrompt(cancellation)).toEqual({
        _tag: "Pending",
        targetCommandId: cancellation.targetCommandId,
      })
      expect(yield* store.cancelPrompt(cancellation)).toEqual({
        _tag: "Pending",
        targetCommandId: cancellation.targetCommandId,
      })
      expect(
        yield* store.admitPrompt({
          ...prompt,
          commandId: cancellation.targetCommandId,
          idempotencyKey: IdempotencyKey.make("cancelled-prompt-key"),
          turnId: TurnId.make("cancelled-prompt-turn"),
          readinessProof: true,
        }),
      ).toEqual({ _tag: "Cancelled", targetCommandId: cancellation.targetCommandId })
      expect(
        yield* store.cancelPrompt({
          ...cancellation,
          cancelCommandId: CommandId.make("cancel-after-admission"),
          targetCommandId: prompt.commandId,
        }),
      ).toEqual({ _tag: "Turn", targetCommandId: prompt.commandId, turnId: prompt.turnId })
      expect(
        (yield* store.readCommands({
          ownerId: personalOwnerId,
          threadId: thread.id,
          actor: personalActor,
          afterCommitCursor: CommitCursor.make("0"),
          limit: 10,
        })).filter((command) => command.command._tag === "SubmitPrompt"),
      ).toHaveLength(1)
      expect(
        (yield* store.admitCommand({
          ownerId: personalOwnerId,
          threadId: thread.id,
          commandId: CommandId.make("cancel-command"),
          idempotencyKey: IdempotencyKey.make("cancel-key"),
          actor: personalActor,
          command: { _tag: "Cancel" },
          admittedAt: now,
        })).command,
      ).toEqual({ _tag: "Cancel" })
      expect(
        yield* store
          .authorizeThread({
            ownerId: personalOwnerId,
            threadId: thread.id,
            actor: personalActor,
            action: "thread:view",
            at: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
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
            executorKind: "orb",
            now,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "not-found" } })
    }),
  )
})
