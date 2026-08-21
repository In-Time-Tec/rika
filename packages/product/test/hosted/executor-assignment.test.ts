import { expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { ExecutorAssignment } from "../../src/hosted/executor-assignment"

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
  const e2bPlacement = { _tag: "E2BPlacement", templateBuildId: "build-1", providerScope: "scope-1" }
  const localPlacement = {
    _tag: "LocalDevicePlacement",
    deviceId: "device-1",
    checkoutFingerprint: "checkout-1",
    requestingDeviceId: "device-1",
  }

  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "e2b", placement: e2bPlacement })).toBe(true)
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "local_device", placement: localPlacement })).toBe(true)
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "local_device", placement: e2bPlacement })).toBe(false)
  expect(Schema.is(ExecutorAssignment)({ ...base, executorKind: "e2b", placement: localPlacement })).toBe(false)
})
