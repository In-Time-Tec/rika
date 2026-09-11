import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { BoxWorkspaceInputError } from "@rika/box-executor/workspace-input-contract"
import { Archive, StoredArchive } from "@rika/workspace-input/contract"
import { WorkspaceSeedVaultError } from "@rika/workspace-input/vault"
import { ProductControlError } from "../../src/product/control"
import {
  assignmentRow,
  binding,
  boxId,
  checkout,
  repositoryInput,
  runnerBinding,
  seedArchive,
  workspaceInputHarness,
  workspaceSeed,
  type WorkspaceInputHarnessBehavior,
} from "./box-workspace-input.support"

const harness = (behavior: WorkspaceInputHarnessBehavior = {}) => workspaceInputHarness([], behavior)
const rowWithSources = assignmentRow({ checkout, workspaceSeed })

it.effect("materializes the admitted repository and seed under the binding policy", () =>
  Effect.gen(function* () {
    const test = harness()
    yield* test.ensure(rowWithSources, boxId, binding)
    expect(test.calls).toEqual(["inspect", "capture", "vault", "materialize"])
    const policy = test.policies[0]
    expect(policy?.workspaceId).toBe(binding.workspaceId)
    expect(policy?.placement).toEqual(binding.placement)
    expect(policy?.buildId).toBe(binding.buildId)
    expect(policy?.protocolVersion).toBe(binding.protocolVersion)
    expect(policy?.checkout).toEqual(checkout)
    expect(policy?.seed).toEqual({
      id: workspaceSeed.id,
      sourceRepository: workspaceSeed.sourceRepository,
      archiveDigest: workspaceSeed.archiveDigest,
      archiveSizeBytes: workspaceSeed.archiveSizeBytes,
    })
    expect(policy !== undefined && policy.seed !== null && !("objectKey" in policy.seed)).toBe(true)
    expect(test.captured).toEqual([checkout])
    expect(test.loaded).toEqual([
      {
        seedId: workspaceSeed.id,
        stored: StoredArchive.make({
          objectKey: workspaceSeed.objectKey,
          contentDigest: workspaceSeed.contentDigest,
          sizeBytes: workspaceSeed.sizeBytes,
          archiveDigest: workspaceSeed.archiveDigest,
          archiveSizeBytes: workspaceSeed.archiveSizeBytes,
          encryption: workspaceSeed.encryption,
        }),
      },
    ])
    expect(test.materialized).toEqual([{ repository: repositoryInput.archive, seed: seedArchive }])
  }),
)

it.effect("returns early without resolving sources when the box receipt already matches the policy", () =>
  Effect.gen(function* () {
    const test = harness({ inspect: true })
    yield* test.ensure(rowWithSources, boxId, binding)
    expect(test.calls).toEqual(["inspect"])
    expect(test.materialized).toEqual([])
    expect(test.captured).toEqual([])
    expect(test.loaded).toEqual([])
  }),
)

it.effect("rejects the admission when materialization reports an occupied workspace", () =>
  Effect.gen(function* () {
    const test = harness({
      inspect: false,
      materializeError: BoxWorkspaceInputError.make({ reason: "conflict", message: "occupied" }),
    })
    const result = yield* Effect.result(test.ensure(rowWithSources, boxId, binding))
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "binding" } })
    expect(test.calls).toEqual(["inspect", "capture", "vault", "materialize"])
  }),
)

it.effect("reports transport, archive, and source failures as unavailable", () =>
  Effect.gen(function* () {
    const transport = harness({
      inspect: false,
      materializeError: BoxWorkspaceInputError.make({ reason: "transport", message: "unreachable" }),
    })
    expect(yield* Effect.result(transport.ensure(rowWithSources, boxId, binding))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "reader" },
    })
    const inspected = harness({
      inspectError: BoxWorkspaceInputError.make({ reason: "conflict", message: "stale receipt" }),
    })
    expect(yield* Effect.result(inspected.ensure(rowWithSources, boxId, binding))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "binding" },
    })
    const captured = harness({
      inspect: false,
      captureError: ProductControlError.make({ kind: "forbidden", message: "denied" }),
    })
    expect(yield* Effect.result(captured.ensure(rowWithSources, boxId, binding))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "reader" },
    })
    const vaulted = harness({
      inspect: false,
      vaultError: WorkspaceSeedVaultError.make({ kind: "missing", message: "gone" }),
    })
    expect(yield* Effect.result(vaulted.ensure(rowWithSources, boxId, binding))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "reader" },
    })
  }),
)

it.effect("rejects source archives whose descriptors diverge from the admitted policy", () =>
  Effect.gen(function* () {
    const divergent = harness({
      inspect: false,
      seedArchive: Archive.make({
        bytes: new Uint8Array([1]),
        contentDigest: `sha256:${"4".repeat(64)}`,
        sizeBytes: 1,
      }),
    })
    const result = yield* Effect.result(divergent.ensure(rowWithSources, boxId, binding))
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "binding" } })
    expect(divergent.calls).toEqual(["inspect", "capture", "vault"])
    expect(divergent.materialized).toEqual([])
  }),
)

it.effect("rejects bindings that are not admitted for an Orb workspace", () =>
  Effect.gen(function* () {
    const test = harness()
    const result = yield* Effect.result(test.ensure(rowWithSources, boxId, runnerBinding))
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "binding" } })
    expect(test.calls).toEqual([])
  }),
)
