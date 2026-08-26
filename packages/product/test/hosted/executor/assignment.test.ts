import { expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { ExecutorAssignment, RepositoryCheckout } from "../../../src/hosted/executor/assignment"

const base = {
  id: "assignment-1",
  ownerId: "owner-1",
  threadId: "thread-1",
  workspaceId: "workspace-1",
  checkout: null,
  generation: "1",
  revision: "0",
  lastLeaseEpoch: "0",
  lifecycle: { _tag: "Pending" },
  capabilityGeneration: null,
  capabilities: null,
  cursor: { sequence: "0", value: "" },
  latestCheckpointId: null,
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

it("rejects executor kinds that contradict their placement", () => {
  const e2bPlacement = { _tag: "OrbPlacement", templateBuildId: "build-1", providerScope: "scope-1" }
  const localPlacement = {
    _tag: "RunnerPlacement",
    deviceId: "device-1",
    checkoutFingerprint: "checkout-1",
    requestingDeviceId: "device-1",
  }

  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "orb", placement: e2bPlacement })).toBe(true)
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "runner", placement: localPlacement })).toBe(true)
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "runner", placement: e2bPlacement })).toBe(false)
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "orb", placement: localPlacement })).toBe(false)
})

it("requires a complete immutable checkout identity owned by its remote assignment", () => {
  const checkout = {
    ownerId: "owner-1",
    projectId: "project-1",
    repositoryId: "repository-1",
    installationId: "installation-1",
    owner: "In-Time-Tec",
    name: "rika",
    ref: "main",
    commitSha: "a".repeat(40),
    private: true,
    gitIdentity: { name: "Rika User", email: "rika@example.test" },
  }
  expect(Schema.is(RepositoryCheckout)(checkout)).toBe(true)
  for (const invalid of [
    { ...checkout, commitSha: "main" },
    { ...checkout, commitSha: "A".repeat(40) },
    { ...checkout, repositoryId: "" },
    { ...checkout, ref: "" },
    { ...checkout, gitIdentity: { ...checkout.gitIdentity, email: "invalid" } },
  ])
    expect(Schema.is(RepositoryCheckout)(invalid)).toBe(false)
  const placement = { _tag: "OrbPlacement", templateBuildId: "build-1", providerScope: "scope-1" }
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "orb", placement, checkout })).toBe(true)
  expect(
    Schema.is(ExecutorAssignment)({
      ...base,
      executorKind: "orb",
      placement,
      checkout: { ...checkout, ownerId: "owner-2" },
    }),
  ).toBe(false)
  expect(
    Schema.is(ExecutorAssignment)({
      ...base,
      executorKind: "runner",
      placement: { _tag: "RunnerPlacement", deviceId: "device-1" },
      checkout,
    }),
  ).toBe(false)
})
