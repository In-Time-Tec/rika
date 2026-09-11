import { expect, it } from "@effect/vitest"
import { sql } from "drizzle-orm"
import { Effect, Encoding, Schema } from "effect"
import { BoxAssignmentProjection, type BindBoxAssignmentInput } from "../../../src/hosted/assignment-store/box"
import { BoxAssignmentIdentity } from "../../../src/hosted/assignment-store/box-assignment-identity"
import { live } from "../assignments.support"
import {
  checkout,
  fencedId,
  fixture,
  placement,
  readBindings,
  readStored,
  rikaBoxAssignmentBindings,
  seedAssignment,
  seedRunnerAssignment,
  workspaceSeed,
} from "./box.fixture"

const BoxAssignmentProjectionJson = Schema.fromJsonString(BoxAssignmentProjection)

it.effect.skipIf(!live)("binds one competing Box and makes its exact retry idempotent", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const identity = yield* seedAssignment(database, {
        suffix: "race",
        checkout,
        workspaceSeed,
      })
      const before = yield* readStored(database, identity.rawAssignmentId)
      const initial = yield* repository.get(identity.assignmentId)
      if (initial === undefined) return yield* Effect.die("Box assignment fixture was unavailable")
      expect(initial).toMatchObject({
        assignmentId: identity.assignmentId,
        threadId: identity.threadId,
        workspaceId: identity.workspaceId,
        generation: 1,
        placement,
        providerInstanceId: null,
        lifecycle: "pending",
        checkout,
        workspaceSeed,
      })
      expect(Schema.is(BoxAssignmentIdentity)(identity.assignmentId)).toBe(true)
      expect(identity.assignmentId.length).toBeLessThanOrEqual(256)
      expect(Schema.is(BoxAssignmentProjection)(initial)).toBe(true)
      const encodedProjection = yield* Schema.encodeEffect(BoxAssignmentProjectionJson)(initial)
      expect(yield* Schema.decodeEffect(BoxAssignmentProjectionJson)(encodedProjection)).toEqual(initial)
      expect((yield* readStored(database, identity.rawAssignmentId)).providerInstanceId).toBeNull()
      expect(yield* readBindings(database, identity.rawAssignmentId)).toEqual([])
      expect(before).toMatchObject({
        lifecycle: "pending",
        providerInstanceId: null,
        bootstrapDigest: null,
        bootstrapExpiresAt: null,
        executorInstanceId: null,
        processIncarnation: null,
        sessionDigest: null,
        leaseEpoch: null,
        leaseExpiresAt: null,
      })
      const bind = (boxId: string) => repository.bind({ ...identity, generation: 1, placement, boxId })
      const attempts = yield* Effect.all([Effect.result(bind("bx_23456789")), Effect.result(bind("bx_abcdefgh"))], {
        concurrency: "unbounded",
      })
      const winner = attempts.find((attempt) => attempt._tag === "Success")
      const loser = attempts.find((attempt) => attempt._tag === "Failure")
      expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(1)
      expect(loser).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
      if (winner?._tag !== "Success") return yield* Effect.die("Box binding race did not produce a winner")
      const boxId = winner.success.providerInstanceId
      if (boxId === null) return yield* Effect.die("Box binding winner is unbound")
      const bound = yield* readStored(database, identity.rawAssignmentId)
      expect(bound).toEqual(before)
      const storedBinding = (yield* readBindings(database, identity.rawAssignmentId))[0]
      expect(storedBinding).toMatchObject({ assignmentId: identity.rawAssignmentId, generation: 1, boxId })
      const retry = yield* bind(boxId)
      expect(retry).toEqual(winner.success)
      expect((yield* readBindings(database, identity.rawAssignmentId))[0]).toEqual(storedBinding)
    }),
  ),
)

it.effect.skipIf(!live)("rejects raw, malformed, noncanonical, mismatched, and stale Box fences", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const identity = yield* seedAssignment(database, { suffix: "fence" })
      const exact: BindBoxAssignmentInput = {
        ...identity,
        generation: 1,
        placement,
        boxId: "bx_23456789",
      }
      const malformed = "bxa_not_a_json_tuple"
      const noncanonical = `bxa_${Encoding.encodeBase64Url(` ["${identity.rawAssignmentId}",1]`)}`
      expect(Schema.is(BoxAssignmentIdentity)(noncanonical)).toBe(false)
      for (const assignmentId of [identity.rawAssignmentId, malformed, noncanonical]) {
        expect(yield* Effect.result(repository.get(assignmentId))).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid" },
        })
        expect(yield* Effect.result(repository.bind({ ...exact, assignmentId }))).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid" },
        })
      }
      const wrongGenerationId = fencedId(identity.rawAssignmentId, 2)
      expect(yield* Effect.result(repository.get(wrongGenerationId))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })
      expect(
        yield* Effect.result(repository.bind({ ...exact, assignmentId: wrongGenerationId, generation: 2 })),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
      const stale: ReadonlyArray<BindBoxAssignmentInput> = [
        { ...exact, generation: 2 },
        { ...exact, workspaceId: "box-workspace-other" },
        { ...exact, placement: { ...placement, lineageId: "box-lineage-other" } },
        { ...exact, placement: { ...placement, templateBuildId: "box-template-other" } },
        { ...exact, placement: { ...placement, providerScope: "box-provider-other" } },
        {
          ...exact,
          placement: { ...placement, executorPolicy: { ...placement.executorPolicy, buildId: "executor-build-other" } },
        },
        {
          ...exact,
          placement: { ...placement, executorPolicy: { ...placement.executorPolicy, protocolVersion: 2 } },
        },
      ]
      for (const input of stale)
        expect(yield* Effect.result(repository.bind(input))).toMatchObject({
          _tag: "Failure",
          failure: { reason: "stale-fence" },
        })
      expect(
        yield* Effect.result(repository.bind({ ...exact, assignmentId: fencedId("box-assignment-other", 1) })),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "not-found" } })
      expect(yield* Effect.result(repository.bind({ ...exact, boxId: "box-invalid" }))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid" },
      })
      expect((yield* readStored(database, identity.rawAssignmentId)).providerInstanceId).toBeNull()
      expect(yield* readBindings(database, identity.rawAssignmentId)).toEqual([])
    }),
  ),
)

it.effect.skipIf(!live)("does not mutate paused or terminated assignments", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const paused = yield* seedAssignment(database, {
        suffix: "paused",
        lifecycle: "paused",
        providerInstanceId: "bx_23456789",
      })
      const terminated = yield* seedAssignment(database, { suffix: "terminated", lifecycle: "terminated" })
      const pausedBefore = yield* readStored(database, paused.rawAssignmentId)
      const terminatedBefore = yield* readStored(database, terminated.rawAssignmentId)
      const pausedProjection = yield* repository.get(paused.assignmentId)
      const terminatedProjection = yield* repository.get(terminated.assignmentId)
      if (pausedProjection === undefined || terminatedProjection === undefined)
        return yield* Effect.die("Box state fixture was unavailable")
      expect(pausedProjection).toMatchObject({ providerInstanceId: null })
      expect(
        yield* Effect.result(
          repository.bind({ ...paused, generation: 1, placement, boxId: pausedBefore.providerInstanceId! }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-state" } })
      expect(
        yield* Effect.result(repository.bind({ ...terminated, generation: 1, placement, boxId: "bx_abcdefgh" })),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-state" } })
      expect(yield* Effect.result(repository.rotate(pausedProjection))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-state" },
      })
      expect(yield* Effect.result(repository.rotate(terminatedProjection))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-state" },
      })
      expect(yield* readStored(database, paused.rawAssignmentId)).toEqual(pausedBefore)
      expect(yield* readStored(database, terminated.rawAssignmentId)).toEqual(terminatedBefore)
      expect(yield* readBindings(database, paused.rawAssignmentId)).toEqual([])
      expect(yield* readBindings(database, terminated.rawAssignmentId)).toEqual([])
    }),
  ),
)

it.effect.skipIf(!live)("rotates the fence without replacing the product row and retries exactly once", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const identity = yield* seedAssignment(database, {
        suffix: "rotate",
        checkout,
        workspaceSeed,
      })
      const initial = yield* repository.get(identity.assignmentId)
      if (initial === undefined) return yield* Effect.die("Box rotation fixture was unavailable")
      const bound = yield* repository.bind({
        assignmentId: initial.assignmentId,
        generation: initial.generation,
        workspaceId: initial.workspaceId,
        placement: initial.placement,
        boxId: "bx_23456789",
      })
      const before = yield* readStored(database, identity.rawAssignmentId)
      const rotated = yield* repository.rotate(bound)

      expect(rotated).toMatchObject({
        ownerId: bound.ownerId,
        threadId: bound.threadId,
        workspaceId: bound.workspaceId,
        generation: 2,
        placement,
        providerInstanceId: "bx_23456789",
        lifecycle: "pending",
        checkout,
        workspaceSeed,
      })
      expect(rotated.assignmentId).not.toBe(bound.assignmentId)
      expect(rotated.assignmentId).toBe(fencedId(identity.rawAssignmentId, 2))
      expect(Schema.is(BoxAssignmentProjection)(rotated)).toBe(true)
      expect(yield* readStored(database, identity.rawAssignmentId)).toMatchObject({
        id: identity.rawAssignmentId,
        ownerId: bound.ownerId,
        threadId: bound.threadId,
        workspaceId: bound.workspaceId,
        generation: 2,
        revision: before.revision + 1,
        lifecycle: "pending",
        providerInstanceId: null,
        bootstrapDigest: null,
        bootstrapExpiresAt: null,
        executorInstanceId: null,
        processIncarnation: null,
        sessionDigest: null,
        leaseEpoch: null,
        leaseExpiresAt: null,
        checkout,
        workspaceSeed,
      })
      expect(yield* readBindings(database, identity.rawAssignmentId)).toMatchObject([
        { assignmentId: identity.rawAssignmentId, generation: 1, boxId: "bx_23456789" },
        { assignmentId: identity.rawAssignmentId, generation: 2, boxId: "bx_23456789" },
      ])

      expect(yield* repository.rotate(bound)).toEqual(rotated)
      expect(yield* Effect.result(repository.rotate({ ...bound, providerInstanceId: "bx_abcdefgh" }))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "conflict" },
      })
      expect(
        yield* Effect.result(
          repository.rotate({ ...bound, placement: { ...bound.placement, providerScope: "box-provider-other" } }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
      expect(yield* Effect.result(repository.rotate({ ...bound, ownerId: "box-owner-other" }))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })

      const third = yield* repository.rotate(rotated)
      expect(third).toMatchObject({ generation: 3, providerInstanceId: "bx_23456789" })
      expect(third.assignmentId).toBe(fencedId(identity.rawAssignmentId, 3))
      expect(yield* Effect.result(repository.rotate(bound))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })

      const changedIdentity = yield* seedAssignment(database, { suffix: "changed-binding" })
      const changedInitial = yield* repository.get(changedIdentity.assignmentId)
      if (changedInitial === undefined) return yield* Effect.die("Changed binding fixture was unavailable")
      const changedBound = yield* repository.bind({
        assignmentId: changedInitial.assignmentId,
        generation: changedInitial.generation,
        workspaceId: changedInitial.workspaceId,
        placement: changedInitial.placement,
        boxId: "bx_23456789",
      })
      yield* repository.rotate(changedBound)
      yield* database
        .update(rikaBoxAssignmentBindings)
        .set({ boxId: "bx_abcdefgh" })
        .where(
          sql`${rikaBoxAssignmentBindings.assignmentId} = ${changedIdentity.rawAssignmentId} and ${rikaBoxAssignmentBindings.generation} = 2`,
        )
      expect(yield* Effect.result(repository.rotate(changedBound))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "conflict" },
      })
    }),
  ),
)

it.effect.skipIf(!live)("serializes concurrent exact rotations as one next generation", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const identity = yield* seedAssignment(database, { suffix: "concurrent" })
      const initial = yield* repository.get(identity.assignmentId)
      if (initial === undefined) return yield* Effect.die("Concurrent rotation fixture was unavailable")
      const bound = yield* repository.bind({
        assignmentId: initial.assignmentId,
        generation: initial.generation,
        workspaceId: initial.workspaceId,
        placement: initial.placement,
        boxId: "bx_23456789",
      })
      const attempts = yield* Effect.all([repository.rotate(bound), repository.rotate(bound)], {
        concurrency: "unbounded",
      })
      expect(attempts[0]).toEqual(attempts[1])
      expect(attempts[0]).toMatchObject({ generation: 2, providerInstanceId: "bx_23456789" })
      expect(yield* readStored(database, identity.rawAssignmentId)).toMatchObject({ generation: 2, revision: 1 })
      expect(yield* readBindings(database, identity.rawAssignmentId)).toMatchObject([
        { generation: 1, boxId: "bx_23456789" },
        { generation: 2, boxId: "bx_23456789" },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("projects fenced identities only for Orb execution contexts", () =>
  fixture(({ repository, database, product }) =>
    Effect.gen(function* () {
      const orb = yield* seedAssignment(database, { suffix: "context" })
      const initial = yield* repository.get(orb.assignmentId)
      if (initial === undefined) return yield* Effect.die("Orb context fixture was unavailable")
      expect(yield* product.threadExecutionContext("box-owner", orb.threadId)).toMatchObject({
        assignmentId: orb.assignmentId,
        generation: "1",
        executorKind: "orb",
      })
      const bound = yield* repository.bind({
        assignmentId: initial.assignmentId,
        generation: initial.generation,
        workspaceId: initial.workspaceId,
        placement: initial.placement,
        boxId: "bx_23456789",
      })
      const rotated = yield* repository.rotate(bound)
      expect(yield* product.threadExecutionContext("box-owner", orb.threadId)).toMatchObject({
        assignmentId: rotated.assignmentId,
        generation: "2",
        executorKind: "orb",
      })

      const runner = yield* seedRunnerAssignment(database, "context")
      expect(yield* product.threadExecutionContext("box-owner", runner.threadId)).toMatchObject({
        assignmentId: runner.assignmentId,
        generation: "1",
        executorKind: "runner",
      })
    }),
  ),
)
