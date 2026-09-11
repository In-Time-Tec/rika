import { Effect, Ref, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { BoxId } from "@rika/box-executor"
import { WorkspaceBinding } from "@rika/execution"
import { BoxAssignmentError, type BoxAssignmentProjection } from "@rika/product-store/box-assignments"
import { boxWorkspaceBinding, makeBoxBindingReader } from "../../src/executor/box-binding"

const boxId = Schema.decodeSync(BoxId)("bx_23456789")
const otherBoxId = Schema.decodeSync(BoxId)("bx_abcdefgh")
const projection: BoxAssignmentProjection = {
  assignmentId: "assignment",
  ownerId: "owner",
  threadId: "thread",
  workspaceId: "workspace",
  generation: 1,
  lifecycle: "pending",
  providerInstanceId: boxId,
  checkout: null,
  workspaceSeed: null,
  placement: {
    _tag: "OrbPlacement",
    lineageId: "lineage",
    templateBuildId: "template",
    providerScope: "scope",
    executorPolicy: { buildId: "build", protocolVersion: 1 },
  },
}

it.effect("reads the product-only Box association without granting a different provider or mutating metadata", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0)
    const read = makeBoxBindingReader({
      environment: "test",
      assignments: {
        get: () => Ref.update(reads, (value) => value + 1).pipe(Effect.as(projection)),
      },
    })
    const expected = yield* boxWorkspaceBinding(projection)
    expect(yield* Ref.get(reads)).toBe(0)
    const binding = yield* read(boxId, expected)
    expect(binding).toMatchObject({
      partition: { environment: "test", ownerId: "owner", threadId: "thread", target: "orb" },
      workspaceBinding: expected,
    })
    expect(yield* read(otherBoxId, expected)).toBeUndefined()
    expect(yield* Ref.get(reads)).toBe(2)
  }),
)

it.effect("rejects missing, paused, terminated, and superseded Box bindings", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<BoxAssignmentProjection | undefined>(projection)
    const read = makeBoxBindingReader({ environment: "test", assignments: { get: () => Ref.get(state) } })
    const expected = yield* boxWorkspaceBinding(projection)
    const replacements: ReadonlyArray<BoxAssignmentProjection | undefined> = [
      undefined,
      { ...projection, providerInstanceId: null },
      { ...projection, lifecycle: "paused" },
      { ...projection, lifecycle: "terminated" },
      { ...projection, generation: 2 },
      { ...projection, assignmentId: "replacement" },
      { ...projection, workspaceId: "replacement" },
      { ...projection, placement: { ...projection.placement, lineageId: "replacement" } },
      {
        ...projection,
        placement: { ...projection.placement, executorPolicy: { buildId: "replacement", protocolVersion: 1 } },
      },
      {
        ...projection,
        placement: { ...projection.placement, executorPolicy: { buildId: "build", protocolVersion: 2 } },
      },
    ]
    for (const replacement of replacements) {
      yield* Ref.set(state, replacement)
      expect(yield* read(boxId, expected)).toBeUndefined()
    }
  }),
)

it.effect("rejects malformed persisted fences and strips database error details", () =>
  Effect.gen(function* () {
    const expected = yield* boxWorkspaceBinding(projection)
    const read = makeBoxBindingReader({
      environment: "test",
      assignments: {
        get: () => Effect.fail(BoxAssignmentError.make({ reason: "database", message: "private database detail" })),
      },
    })
    expect(yield* Effect.result(read(boxId, expected))).toMatchObject({
      _tag: "Failure",
      failure: { message: "Box assignment authority is unavailable" },
    })
    expect(yield* Effect.result(boxWorkspaceBinding({ ...projection, generation: 0 }))).toMatchObject({
      _tag: "Failure",
    })
    expect(Schema.is(WorkspaceBinding)(expected)).toBe(true)
  }),
)
