import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { ProductRepositoryError, type ThreadExecutionProjection } from "@rika/product-store/product-repository"
import { makeThreadBindingReader } from "../../src/executor/binding"

const policy = { buildId: "executor-build", protocolVersion: 1 }
const runnerPlacement = {
  _tag: "RunnerPlacement",
  deviceId: "device",
  requestingDeviceId: "device",
  checkoutFingerprint: "checkout",
  executorPolicy: policy,
}
const row: ThreadExecutionProjection = {
  assignmentId: "assignment",
  workspaceId: "workspace",
  title: "Thread",
  hasTurns: false,
  executorKind: "runner",
  generation: "1",
  lifecycle: "pending",
  executorInstanceId: null,
  providerInstanceId: null,
  checkout: null,
  localRepository: null,
  placement: runnerPlacement,
}
const fixture = (value: ThreadExecutionProjection) =>
  makeThreadBindingReader({
    environment: "test",
    product: { threadExecutionContext: () => Effect.succeed(value) },
  })
const input = { ownerId: "owner", threadId: "thread" }

it.effect("reads the full persisted Runner binding without acquiring or changing an assignment", () =>
  Effect.gen(function* () {
    const requested: string[][] = []
    const read = makeThreadBindingReader({
      environment: "test",
      product: {
        threadExecutionContext: (ownerId, threadId) =>
          Effect.sync(() => {
            requested.push([ownerId, threadId])
            return row
          }),
      },
    })
    expect((yield* read(input))?.workspaceBinding).toEqual({
      assignmentId: "assignment",
      workspaceId: "workspace",
      generation: 1,
      ...policy,
      placement: { _tag: "Runner", workspaceId: "workspace", checkoutFingerprint: "checkout" },
    })
    expect(requested).toEqual([["owner", "thread"]])
  }),
)

it.effect("uses the persisted Box lineage instead of a provider instance or wake identity", () =>
  Effect.gen(function* () {
    const read = fixture({
      ...row,
      executorKind: "orb",
      providerInstanceId: "replaceable-box",
      placement: {
        _tag: "OrbPlacement",
        templateBuildId: "template",
        providerScope: "provider",
        lineageId: "lineage",
        executorPolicy: policy,
      },
    })
    const binding = yield* read(input)
    expect(binding?.workspaceBinding.placement).toEqual({ _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" })
    expect(yield* read(input)).toEqual(binding)
  }),
)

it.effect("fails closed on missing policy, incomplete lineage, target mismatches, and invalid fences", () =>
  Effect.gen(function* () {
    const cases: ThreadExecutionProjection[] = [
      {
        ...row,
        placement: {
          _tag: "RunnerPlacement",
          deviceId: "device",
          requestingDeviceId: "device",
          checkoutFingerprint: "checkout",
        },
      },
      {
        ...row,
        executorKind: "orb",
        placement: {
          _tag: "OrbPlacement",
          templateBuildId: "template",
          providerScope: "provider",
          executorPolicy: policy,
        },
      },
      { ...row, executorKind: "orb" },
      { ...row, generation: "0" },
      { ...row, placement: { ...runnerPlacement, executorPolicy: { ...policy, buildId: "" } } },
      { ...row, placement: { ...runnerPlacement, executorPolicy: { ...policy, protocolVersion: 0 } } },
    ]
    for (const value of cases) expect((yield* fixture(value)(input).pipe(Effect.flip)).kind).toBe("invalid")
  }),
)

it.effect("returns absence without creation and redacts database failures", () =>
  Effect.gen(function* () {
    const missing = makeThreadBindingReader({
      environment: "test",
      product: {
        threadExecutionContext: () => Effect.void.pipe(Effect.as<ThreadExecutionProjection | undefined>(undefined)),
      },
    })
    expect(yield* missing(input)).toBeUndefined()
    const failed = makeThreadBindingReader({
      environment: "test",
      product: {
        threadExecutionContext: () =>
          ProductRepositoryError.make({ kind: "unavailable", message: "private connection details" }),
      },
    })
    const failure = yield* failed(input).pipe(Effect.flip)
    expect(failure.kind).toBe("unavailable")
    expect(failure.message).not.toContain("private")
  }),
)
