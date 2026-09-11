import { BunCrypto } from "@effect/platform-bun"
import { it } from "@effect/vitest"
import { Context, Effect, Encoding, Layer, Ref, Schema } from "effect"
import { ModelRegistry, Pins } from "generalist"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"
import {
  BoxId,
  LifecyclePolicy,
  SnapshotReference,
  WorkspaceEnrollmentError,
  type BoxProviderService,
  type BoxState,
} from "@rika/box-executor"
import type { BoxWorkspaceInputClient } from "@rika/box-executor/workspace-input"
import { ContextMaterializationError, makeContextMaterializer } from "@rika/context"
import { toEvidence, WorkspaceBinding } from "@rika/execution"
import { tools } from "@rika/execution/tools"
import { BoxAssignmentError, BoxAssignmentProjection } from "@rika/product-store/box-assignments"
import { Archive } from "@rika/workspace-input/contract"
import {
  checkout,
  repositoryInput,
  seedArchive,
  workspaceSeed,
} from "../executor/box-workspace-input.support"
import { boxTemplateBuildId, makeBoxPreparation } from "../../src/executor/box-preparation"
import { boxWorkspaceBinding } from "../../src/executor/box-binding"
import { makeBoxWorkspaceInputInitializer } from "../../src/executor/box-workspace-input"
import { hostEffect } from "../../src/runtime/host"
import { threadPartition } from "../../src/runtime/partition"
import { makeRuntimeWorkspace } from "../../src/runtime/workspace"
import { unavailableWorkspace } from "../fixtures/context"

const sourceBox = Schema.decodeSync(BoxId)("bx_23456789")
const preparedBox = Schema.decodeSync(BoxId)("bx_abcdefgh")
const assignmentId = (generation: number) =>
  `bxa_${Encoding.encodeBase64Url(JSON.stringify(["assignment", generation]))}`
const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "orb" })
const sessionId = partition.rootSessionId
const orbBinding = (generation: number) =>
  Schema.decodeSync(WorkspaceBinding)({
    workspaceId: "workspace",
    assignmentId: assignmentId(generation),
    generation,
    placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
    buildId: "build",
    protocolVersion: 1,
  })
const enrollmentFailure = Schema.encodeSync(WorkspaceEnrollmentError)(
  Schema.decodeSync(WorkspaceEnrollmentError)({
    _tag: "RikaBoxV2WorkspaceEnrollmentError",
    phase: "enroll",
    message: "Interrupted before daemon enrollment",
  }),
)
const snapshot = Schema.decodeSync(SnapshotReference)({
  id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
  boxId: preparedBox,
  generation: 1,
  completedAt: "2026-09-10T00:00:00Z",
  sizeBytes: 100,
  fileCount: 1,
})
const policy = Schema.decodeSync(LifecyclePolicy)({
  template: { sourceBoxId: sourceBox, snapshotId: snapshot.id },
  ttlSeconds: 3_600,
  readinessAttempts: 2,
  readinessDelayMillis: 0,
})
const materialization = (binding: WorkspaceBinding, content: string) =>
  makeContextMaterializer({
    readGuidance: () => Effect.succeed(content.length === 0 ? [] : [{ path: "AGENTS.md", content }]),
    listSkills: () => Effect.succeed([]),
  }).discover({
    binding,
    sessionId,
    guidanceScope: `${sessionId}/workspace`,
    capturedAt: "2026-09-10T00:00:00.000Z",
    model: { selection: { provider: "test", model: "preparation" }, settings: {}, credentialRefs: [] },
    tools: tools.map((tool) => ({ name: tool.name, pin: Pins.makeCapability({ name: tool.name }) })),
  })

const runtimeLayer = (bucket: Parameters<typeof DurabilityTesting.layer>[0]) =>
  durabilityLayer({
    environment: "preparation-test",
    tenant: "owner",
    partition: "thread",
    addresses: [],
    schedulerMode: "external",
  }).pipe(
    Layer.provide(ExecutableResolver.layerStatic([])),
    Layer.provide(DurabilityTesting.layer(bucket)),
    Layer.provide(BunCrypto.layer),
  )

/**
 * Crash between fence rotation and Runner enrollment: the first Run durably rotates the Orb assignment, resumes
 * the Box, and materializes the workspace input receipt, then fails inside enrollment. The next Run must re-admit
 * the rotated fence, observe the receipt instead of re-materializing, and complete enrollment — never rotating the
 * product fence a second time.
 */
it.live(
  "recovers an interrupted Orb restore without rotating the assignment fence or re-materializing the workspace",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bucket = yield* DurabilityTesting.make()
        const admitted = orbBinding(1)
        const empty = yield* materialization(admitted, "")
        const captured = yield* materialization(admitted, "Recovered workspace guidance")
        const events: Array<string> = []
        const materialized: Array<{ repository: Archive | null; seed: Archive | null }> = []
        const initialRow = yield* Schema.decodeEffect(BoxAssignmentProjection)({
          assignmentId: admitted.assignmentId,
          ownerId: "owner",
          threadId: "thread",
          workspaceId: "workspace",
          generation: 1,
          lifecycle: "pending",
          providerInstanceId: preparedBox,
          checkout,
          workspaceSeed,
          placement: {
            _tag: "OrbPlacement",
            lineageId: "lineage",
            templateBuildId: boxTemplateBuildId(policy.template),
            providerScope: "scope",
            executorPolicy: { buildId: "build", protocolVersion: 1 },
          },
        }).pipe(Effect.orDie)
        const current = yield* Ref.make<BoxAssignmentProjection>(initialRow)
        const boxState = yield* Ref.make<BoxState>("archived")
        let enrollAttempts = 0
        const provider: BoxProviderService = {
          create: () => Effect.die("Preparation must not allocate during restore"),
          stop: () => Effect.die("Preparation must not stop during restore"),
          fork: () => Effect.die("Preparation must not fork during restore"),
          resume: (request) =>
            Effect.sync(() => {
              events.push("resume")
              return { id: request.boxId, state: "ready" as const, snapshotAvailable: true }
            }).pipe(Effect.tap(() => Ref.set(boxState, "ready"))),
          get: (id) =>
            Ref.get(boxState).pipe(
              Effect.map((state) => ({
                id,
                state: id === preparedBox ? state : ("archived" as const),
                snapshotAvailable: true,
              })),
            ),
          latestSnapshot: (boxId) =>
            Effect.sync(() => {
              events.push("snapshot")
              return { ...snapshot, boxId }
            }),
        }
        const workspaceInputClient: BoxWorkspaceInputClient = {
          inspect: () =>
            Effect.sync(() => {
              events.push("inspect")
              return materialized.length > 0
            }),
          materialize: (request) =>
            Effect.sync(() => {
              events.push("materialize")
              materialized.push({ repository: request.repository, seed: request.seed })
              return { version: 1 as const, policyDigest: "0".repeat(64) }
            }),
        }
        const { ensure: ensureWorkspaceInput } = makeBoxWorkspaceInputInitializer({
          client: workspaceInputClient,
          capture: () =>
            Effect.sync(() => {
              events.push("capture")
              return repositoryInput
            }),
          vault: {
            load: () =>
              Effect.sync(() => {
                events.push("vault")
                return seedArchive
              }),
          },
          platform: Context.empty(),
        })
        const prepare = makeBoxPreparation({
          assignments: {
            get: () => Ref.get(current),
            bind: (request) =>
              Effect.sync(() => events.push("bind")).pipe(
                Effect.andThen(
                  Ref.updateAndGet(current, (row) => ({ ...row, providerInstanceId: request.boxId })),
                ),
              ),
            rotate: (expected) =>
              Effect.gen(function* () {
                const row = yield* Ref.get(current)
                if (![expected.generation, expected.generation + 1].includes(row.generation))
                  return yield* BoxAssignmentError.make({
                    reason: "stale-fence",
                    message: "Box assignment fence is stale",
                  })
                if (row.generation === expected.generation + 1) return row
                events.push("rotate")
                return yield* Ref.updateAndGet(current, (value) => ({
                  ...value,
                  assignmentId: assignmentId(value.generation + 1),
                  generation: value.generation + 1,
                }))
              }),
          },
          policy,
          providerScope: "scope",
          provider,
          workspaceInput: ensureWorkspaceInput,
          enrollment: {
            enroll: () =>
              Effect.suspend(() => {
                events.push("enroll")
                enrollAttempts += 1
                return enrollAttempts === 1
                  ? WorkspaceEnrollmentError.make({ phase: "enroll", message: "Interrupted before daemon enrollment" })
                  : Effect.void
              }),
            handshake: (_boxId, expected) =>
              Effect.sync(() => {
                events.push("handshake")
                return toEvidence(expected)
              }),
          },
        })
        let captures = 0
        const bindings: Array<WorkspaceBinding> = []
        for (let incarnation = 0; incarnation < 2; incarnation += 1) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const currentBinding = yield* Ref.get(current).pipe(
                Effect.flatMap((row) => boxWorkspaceBinding(row)),
                Effect.orDie,
              )
              const handle = yield* makeRuntimeWorkspace({
                initial: unavailableWorkspace(currentBinding),
                resolve: (binding) => Effect.succeed(unavailableWorkspace(binding)),
              })
              const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("continued")])])
              yield* Effect.gen(function* () {
                const host = yield* hostEffect({
                  revision: "box-restore-test",
                  workspace: handle.executor,
                  context: {
                    materialization: { ...empty, workspace: currentBinding },
                    ensureWorkspace: (input) =>
                      Ref.get(current).pipe(
                        Effect.flatMap((row) => boxWorkspaceBinding(row)),
                        Effect.mapError(() =>
                          ContextMaterializationError.make({
                            reason: "reader",
                            message: "Box assignment binding is unavailable",
                          }),
                        ),
                        Effect.flatMap((workspaceBinding) =>
                          prepare({
                            ...input,
                            partition,
                            binding: {
                              partition,
                              placement: workspaceBinding.placement,
                              workspaceBinding,
                            },
                          }),
                        ),
                      ),
                    rebindWorkspace: handle.rebind,
                    prepare: () =>
                      Effect.sync(() => {
                        captures += 1
                        return { ...captured, workspace: handle.executor.binding }
                      }),
                    authorization: {
                      current: () =>
                        Effect.succeed({
                          allowedTools: tools.map((tool) => tool.name),
                          allowedModels: [empty.modelPin],
                          allowedCredentials: [],
                        }),
                    },
                    modelRegistry: ModelRegistry.layer([
                      ModelRegistry.registration({ ...empty.model.selection, layer: fixture.layer }),
                    ]),
                  },
                })
                yield* activate
                const session = incarnation === 0
                  ? yield* host.sessions.create({ id: sessionId, agent: "rika" })
                  : yield* host.sessions.get(sessionId)
                yield* session.submit("continue", { commandId: `restore-${incarnation}` })
                const scheduler = yield* LocalScheduler.LocalScheduler
                yield* scheduler.drain({ fuel: 64 }).pipe(Effect.timeout("30 seconds"))
                let record = yield* session.snapshot
                bindings.push(handle.executor.binding)
                if (incarnation === 0) {
                  expect(record.runs.at(-1)?.status).toBe("needs-resolution")
                  const interrupted = record.runs.at(-1)
                  if (interrupted === undefined) return yield* Effect.die("Expected the interrupted Run")
                  const explanation = yield* host.operator.explain(interrupted.runId)
                  const obligation = explanation.obligations.find((entry) => entry._tag === "Unknown")
                  if (obligation === undefined || obligation._tag !== "Unknown")
                    return yield* Effect.die("Expected the parked enrollment obligation")
                  yield* host.operator.resolveUnknown(
                    interrupted.runId,
                    obligation.operationId,
                    {
                      outcome: "failed",
                      error: enrollmentFailure,
                    },
                    "test-operator",
                    "resolve-interrupted-enrollment",
                  )
                  yield* scheduler.drain({ fuel: 64 }).pipe(Effect.timeout("30 seconds"))
                  record = yield* session.snapshot
                  expect(record.runs.at(-1)?.status).toBe("failed")
                } else {
                  expect(record.runs.at(-1)?.status).toBe("succeeded")
                  const requests = yield* fixture.requests
                  expect(requests).toHaveLength(1)
                  expect(
                    requests[0]?.prompt.content.some(
                      (message) =>
                        message.role === "system" &&
                        message.content.includes("Recovered workspace guidance"),
                    ),
                  ).toBe(true)
                  const latest = record.runs.at(-1)
                  if (latest === undefined) return yield* Effect.die("Expected the recovered Run")
                  const execution = yield* (yield* RunStore.RunStore).loadExecution(latest.runId)
                  const component = execution.sessionComponents?.find(
                    (entry) => entry.descriptor.key === "rika.context-v2.session-materialization",
                  )
                  expect(component?.state).toEqual({ ...captured, workspace: bindings[1] })
                }
              }).pipe(Effect.provide(yield* Layer.build(runtimeLayer(bucket))))
            }),
          )
        }
        expect(bindings[0]).toEqual(orbBinding(1))
        expect(bindings[1]).toEqual(orbBinding(2))
        expect(captures).toBe(1)
        expect(enrollAttempts).toBe(2)
        const counts = (event: string) => events.filter((entry) => entry === event).length
        expect(counts("rotate")).toBe(1)
        expect(counts("snapshot")).toBe(2)
        expect(counts("materialize")).toBe(1)
        expect(counts("capture")).toBe(1)
        expect(counts("vault")).toBe(1)
        expect(materialized).toEqual([{ repository: repositoryInput.archive, seed: seedArchive }])
      }),
    ),
)
