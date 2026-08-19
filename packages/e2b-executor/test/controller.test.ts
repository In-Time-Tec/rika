import { describe, expect, it } from "@effect/vitest"
import type { ExecutorAccess } from "@rika/remote-execution/protocol"
import { Effect, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Controller from "../src/controller"
import { assignmentRequest, controller, makeHarness } from "./support/fakes"
import { provideLayer } from "./support/layer"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const provision = Effect.fn("test.provision")(function* () {
  const service = yield* controller
  return yield* service.assign(assignmentRequest)
})

const authenticate = Effect.fn("test.authenticate")(function* (
  harness: ReturnType<typeof makeHarness>,
  generation: number,
) {
  const service = yield* controller
  const request = harness.provider.creates[generation - 1]!
  const fence = {
    target: "e2b" as const,
    assignmentId: assignmentRequest.assignmentId,
    generation,
    instanceId: `sandbox-${generation}`,
    executorId: `${assignmentRequest.assignmentId}:g${generation}`,
  }
  const welcome = yield* service.hello({
    version: 1,
    fence,
    bootstrapToken: request.secrets.RIKA_EXECUTOR_BOOTSTRAP_TOKEN!,
  })
  const access: ExecutorAccess = {
    version: 1,
    fence,
    sessionToken: welcome.sessionToken,
  }
  return { welcome, access }
})

describe("E2BExecutionController", () => {
  it.effect("provisions an explicit assignment from one immutable build with scoped bootstrap identity", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      const first = yield* service.assign(assignmentRequest)
      const second = yield* service.assign(assignmentRequest)
      expect(first).toEqual(second)
      expect(first).toMatchObject({
        assignmentId: "assignment-1",
        workspaceId: "workspace-1",
        generation: 1,
        templateBuildId: "template-build-v1-immutable",
        sandboxId: "sandbox-1",
        state: "running",
      })
      expect(harness.provider.creates).toHaveLength(1)
      expect(harness.provider.creates[0]).toMatchObject({
        templateBuildId: "template-build-v1-immutable",
        assignmentId: "assignment-1",
        generation: 1,
        idleTimeoutMillis: Controller.IdleTimeoutMillis,
        environment: {
          RIKA_EXECUTOR_TARGET: "e2b",
          RIKA_EXECUTOR_ID: "assignment-1:g1",
        },
      })
      const bootstrap = harness.provider.creates[0]!.secrets.RIKA_EXECUTOR_BOOTSTRAP_TOKEN!
      expect(String(bootstrap)).toBe("<redacted:executor-bootstrap>")
      expect(json(first)).not.toContain(Redacted.value(bootstrap))
      expect(harness.records.get("assignment-1")?.bootstrapDigest).not.toBe(Redacted.value(bootstrap))
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("uses filesystem pause, explicit demand resume, lease renewal, and kill", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      expect((yield* service.pause({ assignmentId: "assignment-1", generation: 1 })).state).toBe("paused")
      expect((yield* service.resume({ assignmentId: "assignment-1", generation: 1 })).state).toBe("running")
      const receipt = yield* service.heartbeat({
        version: 1,
        access,
        cursor: { sequence: 1, value: "executor:1" },
      })
      expect(receipt.cursor).toEqual({ sequence: 1, value: "executor:1" })
      expect(harness.provider.pauses).toEqual(["sandbox-1"])
      expect(harness.provider.connects).toEqual([
        { sandboxId: "sandbox-1", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect(harness.provider.touches).toEqual([
        { sandboxId: "sandbox-1", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect((yield* service.kill({ assignmentId: "assignment-1", generation: 1 })).state).toBe("terminated")
      expect(harness.provider.kills).toEqual(["sandbox-1"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("authenticates bootstrap once and never treats sandbox ID possession as authority", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const bootstrap = harness.provider.creates[0]!.secrets.RIKA_EXECUTOR_BOOTSTRAP_TOKEN!
      const fence = {
        target: "e2b" as const,
        assignmentId: "assignment-1",
        generation: 1,
        instanceId: "sandbox-1",
        executorId: "assignment-1:g1",
      }
      expect(
        (yield* Effect.flip(service.hello({ version: 1, fence, bootstrapToken: Redacted.make("wrong") }))).kind,
      ).toBe("authentication")
      const { welcome, access } = yield* authenticate(harness, 1)
      expect(String(welcome.sessionToken)).toBe("<redacted:executor-session>")
      expect((yield* Effect.flip(service.hello({ version: 1, fence, bootstrapToken: bootstrap }))).kind).toBe(
        "authentication",
      )
      expect((yield* Effect.flip(service.reconnect({ ...access, sessionToken: Redacted.make("wrong") }))).kind).toBe(
        "authentication",
      )
      expect(json(welcome)).not.toContain(Redacted.value(welcome.sessionToken))
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("fences stale replacement generations and reconnects idempotently from the durable executor cursor", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      yield* service.heartbeat({
        version: 1,
        access: first.access,
        cursor: { sequence: 4, value: "executor:4" },
      })
      expect(
        (yield* Effect.flip(
          service.heartbeat({
            version: 1,
            access: first.access,
            cursor: { sequence: 3, value: "executor:3" },
          }),
        )).kind,
      ).toBe("protocol")
      yield* TestClock.adjust("2 minutes")
      const reconnected = yield* service.reconnect(first.access)
      const duplicate = yield* service.reconnect(first.access)
      expect(reconnected.cursor).toEqual({ sequence: 4, value: "executor:4" })
      expect(duplicate).toEqual(reconnected)
      const replacement = yield* service.replace({ assignmentId: "assignment-1", generation: 1 })
      expect(replacement).toMatchObject({ generation: 2, sandboxId: "sandbox-2", state: "running" })
      expect(harness.provider.kills).toContain("sandbox-1")
      expect((yield* Effect.flip(service.reconnect(first.access))).kind).toBe("fenced")
      expect((yield* authenticate(harness, 2)).welcome.cursor).toEqual({ sequence: 4, value: "executor:4" })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("accepts only verified generation-scoped object checkpoints and redacts checkout credentials", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      yield* service.heartbeat({
        version: 1,
        access,
        cursor: { sequence: 2, value: "executor:2" },
      })
      const staged = {
        version: 1 as const,
        checkpointId: "checkpoint-1",
        objectKey: "assignments/assignment-1/g1/checkpoint-1.tar.zst",
        contentDigest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 42,
        format: "tar.zst" as const,
        cursor: { sequence: 2, value: "executor:2" },
      }
      const verified = yield* service.checkpoint(access, staged)
      expect(yield* service.checkpoint(access, staged)).toEqual(verified)
      expect(harness.checkpointInspections).toEqual([staged.objectKey])
      harness.checkpointInspection = { ...harness.checkpointInspection, sizeBytes: 41 }
      expect(
        (yield* Effect.flip(
          service.checkpoint(access, { ...staged, checkpointId: "checkpoint-2", objectKey: `${staged.objectKey}.2` }),
        )).kind,
      ).toBe("checkpoint")
      const credential = yield* service.checkout(access)
      expect(credential).toMatchObject({
        repositoryUrl: "https://github.com/In-Time-Tec/rika.git",
        username: "x-access-token",
      })
      expect(String(credential.token)).toBe("<redacted:github-installation-token>")
      expect(json(credential)).not.toContain("ghs_actual_secret")
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("kills only managed inventory entries without a durable assignment", () => {
    const harness = makeHarness()
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-1",
        state: "running",
        templateBuildId: "template-build-v1-immutable",
        metadata: { "rika.managed": "e2b-executor" },
      },
      {
        sandboxId: "sandbox-orphan",
        state: "paused",
        templateBuildId: "template-build-v1-immutable",
        metadata: { "rika.managed": "e2b-executor" },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-orphan"])
      expect(harness.provider.kills).toEqual(["sandbox-orphan"])
    }).pipe(provideLayer(harness.layer))
  })
})
