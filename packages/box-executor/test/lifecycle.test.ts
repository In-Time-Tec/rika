import { Effect, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { toEvidence, type WorkspaceBinding } from "@rika/execution"

import { SnapshotReference, WorkspaceLifecycleIntent, idempotencyWindowMillis } from "../src/contract"
import type { WorkspaceCheckpointService, WorkspaceEnrollmentService } from "../src/enrollment"
import { makeBoxWorkspaceLifecycle, makeBoxWorkspacePreparation } from "../src/lifecycle"
import { BoxProviderError, type BoxProviderService } from "../src/provider"
import { provideLayer } from "./support/layer"
import {
  archivedSource,
  baseProvider,
  checkpoint,
  contextLayer,
  forkedBinding,
  forkedBoxId,
  policy,
  preparedBinding,
  preparedBoxId,
  prepareIntent,
  readyBox,
  resumedBinding,
  resumeIntent,
  snapshot,
  sourceBinding,
  sourceBoxId,
} from "./support/lifecycle"

it.effect("exposes a prepared workspace only after one enrollment and a full binding handshake", () =>
  Effect.gen(function* () {
    const forkRequests: Array<unknown> = []
    const enrollments: Array<WorkspaceBinding> = []
    const provider = baseProvider()
    const enrollment: WorkspaceEnrollmentService = {
      enroll: (_boxId, admitted) =>
        Effect.sync(() => {
          enrollments.push(admitted)
        }),
      handshake: (_boxId, admitted) => Effect.succeed(toEvidence(admitted)),
    }
    const lifecycle = makeBoxWorkspaceLifecycle({
      policy,
      provider: {
        ...provider,
        fork: (request) => Effect.sync(() => forkRequests.push(request)).pipe(Effect.andThen(provider.fork(request))),
      },
      enrollment,
      checkpoint,
    })
    const result = yield* lifecycle.execute(prepareIntent()).pipe(provideLayer(contextLayer("prepare")))
    expect(result).toMatchObject({
      _tag: "Ready",
      lifecycle: "prepared",
      boxId: preparedBoxId,
      binding: preparedBinding,
      evidence: toEvidence(preparedBinding),
    })
    expect(forkRequests).toEqual([
      {
        sourceBoxId,
        idempotencyKey: "prepare-key-1",
        issuedAtMillis: 0,
        expiresAtMillis: idempotencyWindowMillis,
        body: { noEnv: true, env: {}, ttlSeconds: 3_600 },
      },
    ])
    expect(enrollments).toEqual([preparedBinding])
  }),
)

it.effect("rejects stale handshake evidence after provider readiness", () =>
  Effect.gen(function* () {
    const enrollment: WorkspaceEnrollmentService = {
      enroll: () => Effect.void,
      handshake: () => Effect.succeed(toEvidence(sourceBinding)),
    }
    const lifecycle = makeBoxWorkspaceLifecycle({ policy, provider: baseProvider(), enrollment, checkpoint })
    const result = yield* Effect.result(lifecycle.execute(prepareIntent()).pipe(provideLayer(contextLayer("stale"))))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "fenced" } })
  }),
)

it.effect("requires an archived exact template snapshot before issuing the billable fork", () =>
  Effect.gen(function* () {
    let forks = 0
    const provider = baseProvider()
    const mismatched: BoxProviderService = {
      ...provider,
      fork: (request) =>
        Effect.sync(() => {
          forks += 1
        }).pipe(Effect.andThen(provider.fork(request))),
      latestSnapshot: () =>
        Effect.succeed(
          Schema.decodeSync(SnapshotReference)({
            ...snapshot,
            id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef2",
          }),
        ),
    }
    const enrollment: WorkspaceEnrollmentService = {
      enroll: () => Effect.void,
      handshake: (_boxId, admitted) => Effect.succeed(toEvidence(admitted)),
    }
    const lifecycle = makeBoxWorkspaceLifecycle({ policy, provider: mismatched, enrollment, checkpoint })
    const result = yield* Effect.result(lifecycle.execute(prepareIntent()).pipe(provideLayer(contextLayer("pin"))))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "snapshot-mismatch" } })
    expect(forks).toBe(0)
  }),
)

it.effect("exposes public preparation only inside a Generalist durable tool operation", () =>
  Effect.gen(function* () {
    let forks = 0
    const provider = baseProvider()
    const preparation = makeBoxWorkspacePreparation({
      policy,
      provider: {
        ...provider,
        fork: (request) =>
          Effect.sync(() => {
            forks += 1
          }).pipe(Effect.andThen(provider.fork(request))),
      },
      enrollment: {
        enroll: () => Effect.void,
        handshake: (_boxId, admitted) => Effect.succeed(toEvidence(admitted)),
      },
    })

    const outside = yield* Effect.result(preparation.prepare(prepareIntent()))
    expect(outside).toMatchObject({ _tag: "Failure", failure: { kind: "durability-unavailable" } })
    expect(forks).toBe(0)

    const result = yield* preparation.prepare(prepareIntent()).pipe(provideLayer(contextLayer("public-prepare")))

    expect(result).toMatchObject({ _tag: "Ready", lifecycle: "prepared", boxId: preparedBoxId })
    expect(result.lifecycle).toBe("prepared")
    expect(result.evidence).toEqual(toEvidence(preparedBinding))
    expect(forks).toBe(1)
  }),
)

it.effect("exposes public resume only inside a Generalist durable tool operation", () =>
  Effect.gen(function* () {
    let resumes = 0
    const provider = baseProvider()
    const preparation = makeBoxWorkspacePreparation({
      policy,
      provider: {
        ...provider,
        resume: (request) =>
          Effect.sync(() => {
            resumes += 1
          }).pipe(Effect.andThen(provider.resume(request))),
        get: (boxId) => Effect.succeed(resumes > 0 ? readyBox(boxId) : archivedSource),
      },
      enrollment: {
        enroll: () => Effect.void,
        handshake: (_boxId, admitted) => Effect.succeed(toEvidence(admitted)),
      },
    })

    const outside = yield* Effect.result(preparation.resume(resumeIntent()))
    expect(outside).toMatchObject({ _tag: "Failure", failure: { kind: "durability-unavailable" } })
    expect(resumes).toBe(0)

    const result = yield* preparation.resume(resumeIntent()).pipe(provideLayer(contextLayer("public-resume")))
    expect(result).toMatchObject({
      _tag: "Ready",
      lifecycle: "resumed",
      boxId: sourceBoxId,
      binding: resumedBinding,
    })
    expect(resumes).toBe(1)
  }),
)

it.effect("withholds a fork when the latest source snapshot changes after the billable request", () =>
  Effect.gen(function* () {
    let forks = 0
    let snapshotReads = 0
    const provider = baseProvider()
    const changedSnapshot = yield* Schema.decodeEffect(SnapshotReference)({
      ...snapshot,
      id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef2",
    })
    const lifecycle = makeBoxWorkspaceLifecycle({
      policy,
      provider: {
        ...provider,
        fork: (request) =>
          Effect.sync(() => {
            forks += 1
          }).pipe(Effect.andThen(provider.fork(request))),
        latestSnapshot: () =>
          Effect.sync(() => {
            snapshotReads += 1
            return snapshotReads === 1 ? snapshot : changedSnapshot
          }),
      },
      enrollment: {
        enroll: () => Effect.die("a workspace with a changed source pin must not enroll"),
        handshake: () => Effect.die("a workspace with a changed source pin must not handshake"),
      },
      checkpoint,
    })

    const result = yield* Effect.result(
      lifecycle.execute(prepareIntent()).pipe(provideLayer(contextLayer("pin-drift"))),
    )

    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "snapshot-mismatch" } })
    expect(forks).toBe(1)
    expect(snapshotReads).toBe(2)
  }),
)

it.effect("uses fresh enrollment and fences for resume and distinct-lineage fork", () =>
  Effect.gen(function* () {
    const admitted: Array<WorkspaceBinding> = []
    const enrollment: WorkspaceEnrollmentService = {
      enroll: (_boxId, next) =>
        Effect.sync(() => {
          admitted.push(next)
        }),
      handshake: (_boxId, next) => Effect.succeed(toEvidence(next)),
    }
    let resumedSource = false
    const resumeBase = baseProvider()
    const resumeProvider: BoxProviderService = {
      ...resumeBase,
      resume: (request) =>
        Effect.sync(() => {
          resumedSource = true
          return readyBox(request.boxId)
        }),
      get: (boxId) => Effect.succeed(boxId === sourceBoxId && !resumedSource ? archivedSource : readyBox(boxId)),
    }
    const resumeLifecycle = makeBoxWorkspaceLifecycle({
      policy,
      provider: resumeProvider,
      enrollment,
      checkpoint,
    })
    const forkLifecycle = makeBoxWorkspaceLifecycle({
      policy,
      provider: baseProvider([forkedBoxId]),
      enrollment,
      checkpoint,
    })
    const resume = yield* Schema.decodeEffect(WorkspaceLifecycleIntent)({
      _tag: "Resume",
      intentId: "resume-intent-1",
      source: { boxId: sourceBoxId, binding: sourceBinding, snapshot },
      binding: resumedBinding,
      request: { boxId: sourceBoxId, body: { noEnv: true, env: {}, ttlSeconds: 3_600 } },
    })
    const fork = yield* Schema.decodeEffect(WorkspaceLifecycleIntent)({
      _tag: "Fork",
      intentId: "fork-intent-1",
      source: { boxId: sourceBoxId, binding: sourceBinding, snapshot },
      binding: forkedBinding,
      request: {
        sourceBoxId,
        idempotencyKey: "fork-key-1",
        issuedAtMillis: 0,
        expiresAtMillis: idempotencyWindowMillis,
        body: { noEnv: true, env: {}, ttlSeconds: 3_600 },
      },
    })
    const resumed = yield* resumeLifecycle.execute(resume).pipe(provideLayer(contextLayer("resume")))
    const forked = yield* forkLifecycle.execute(fork).pipe(provideLayer(contextLayer("fork")))
    expect(resumed).toMatchObject({ _tag: "Ready", lifecycle: "resumed", binding: resumedBinding })
    expect(forked).toMatchObject({ _tag: "Ready", lifecycle: "forked", binding: forkedBinding })
    expect(resumedBinding.generation).toBeGreaterThan(sourceBinding.generation)
    expect(forkedBinding.placement.lineageId).not.toBe(sourceBinding.placement.lineageId)
    expect(admitted).toEqual([resumedBinding, forkedBinding])
  }),
)

it.effect("reconciles an unknown resume by observing the original Box before enrollment", () =>
  Effect.gen(function* () {
    let resumeRequests = 0
    let resumeIssued = false
    const admitted: Array<WorkspaceBinding> = []
    const provider = baseProvider()
    const lifecycle = makeBoxWorkspaceLifecycle({
      policy,
      provider: {
        ...provider,
        resume: () => {
          resumeRequests += 1
          resumeIssued = true
          return Effect.fail(
            BoxProviderError.make({
              operation: "resume",
              kind: "outcome-unknown",
              message: "Box provider did not confirm the lifecycle outcome",
            }),
          )
        },
        get: (boxId) => Effect.succeed(resumeIssued ? readyBox(boxId) : archivedSource),
      },
      enrollment: {
        enroll: (_boxId, next) =>
          Effect.sync(() => {
            admitted.push(next)
          }),
        handshake: (_boxId, next) => Effect.succeed(toEvidence(next)),
      },
      checkpoint,
    })
    const resume = yield* Schema.decodeEffect(WorkspaceLifecycleIntent)({
      _tag: "Resume",
      intentId: "resume-unknown-1",
      source: { boxId: sourceBoxId, binding: sourceBinding, snapshot },
      binding: resumedBinding,
      request: { boxId: sourceBoxId, body: { noEnv: true, env: {}, ttlSeconds: 3_600 } },
    })

    const result = yield* lifecycle.execute(resume).pipe(provideLayer(contextLayer("resume-unknown")))

    expect(result).toMatchObject({ _tag: "Ready", lifecycle: "resumed", boxId: sourceBoxId })
    expect(resumeRequests).toBe(1)
    expect(admitted).toEqual([resumedBinding])
  }),
)

it.effect("reconciles an unknown stop only after observing archival and its snapshot", () =>
  Effect.gen(function* () {
    const stopBodies: Array<unknown> = []
    const lifecycle = makeBoxWorkspaceLifecycle({
      policy,
      provider: {
        ...baseProvider(),
        stop: (request) => {
          stopBodies.push(request.body)
          return Effect.fail(
            BoxProviderError.make({
              operation: "stop",
              kind: "outcome-unknown",
              message: "Box provider did not confirm the lifecycle outcome",
            }),
          )
        },
        get: () => Effect.succeed(archivedSource),
      },
      enrollment: {
        enroll: () => Effect.die("stop must not enroll"),
        handshake: () => Effect.die("stop must not handshake"),
      },
      checkpoint,
    })
    const stop = yield* Schema.decodeEffect(WorkspaceLifecycleIntent)({
      _tag: "Stop",
      intentId: "stop-unknown-1",
      checkpointIntentId: "checkpoint-unknown-1",
      boxId: sourceBoxId,
      binding: sourceBinding,
      request: { boxId: sourceBoxId, body: { force: false } },
    })

    const result = yield* lifecycle.execute(stop).pipe(provideLayer(contextLayer("stop-unknown")))

    expect(result).toMatchObject({ _tag: "Stopped", boxId: sourceBoxId, snapshot })
    expect(stopBodies).toEqual([{ force: false }])
  }),
)

it.effect("leaves a Box intact when the provider refuses a snapshot-preserving stop", () =>
  Effect.gen(function* () {
    const operations: Array<string> = []
    const provider: BoxProviderService = {
      ...baseProvider(),
      stop: () =>
        Effect.sync(() => operations.push("stop")).pipe(
          Effect.andThen(
            Effect.fail(
              BoxProviderError.make({
                operation: "stop",
                kind: "provider-rejected",
                status: 400,
                code: "snapshot_failed",
                message: "Box provider rejected the request",
              }),
            ),
          ),
        ),
    }
    const barrier: WorkspaceCheckpointService = {
      quiesce: () => Effect.sync(() => operations.push("quiesce")),
      flush: () => Effect.sync(() => operations.push("flush")),
    }
    const enrollment: WorkspaceEnrollmentService = {
      enroll: () => Effect.die("stop must not enroll"),
      handshake: () => Effect.die("stop must not handshake"),
    }
    const lifecycle = makeBoxWorkspaceLifecycle({ policy, provider, enrollment, checkpoint: barrier })
    const stop = yield* Schema.decodeEffect(WorkspaceLifecycleIntent)({
      _tag: "Stop",
      intentId: "stop-intent-1",
      checkpointIntentId: "checkpoint-intent-1",
      boxId: sourceBoxId,
      binding: sourceBinding,
      request: { boxId: sourceBoxId, body: { force: false } },
    })
    const result = yield* Effect.result(lifecycle.execute(stop).pipe(provideLayer(contextLayer("stop"))))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "provider" } })
    expect(operations).toEqual(["quiesce", "flush", "stop"])
  }),
)
