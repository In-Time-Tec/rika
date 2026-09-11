import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { Agent, Approvals, Permissions, ToolExecutor } from "generalist"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { Host } from "generalist/host"
import { ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"
import { toEvidence } from "@rika/execution"

import {
  BoxId,
  ForkRequest,
  LifecyclePolicy,
  OrbWorkspaceBinding,
  SnapshotReference,
  WorkspaceLifecycleIntent,
  WorkspaceLifecycleOutcome,
  idempotencyWindowMillis,
} from "../src/contract"
import { workspaceCheckpointLayer, workspaceEnrollmentLayer } from "../src/enrollment"
import { boxWorkspaceLifecycleLayer } from "../src/lifecycle"
import { BoxProvider, type BoxProviderService } from "../src/provider"
import { boxWorkspaceLifecycleTool, boxWorkspaceLifecycleToolLayer, boxWorkspaceLifecycleToolkit } from "../src/tool"
import { provideLayer } from "./support/layer"

const sourceBoxId = Schema.decodeSync(BoxId)("bx_23456789")
const workspaceBoxId = Schema.decodeSync(BoxId)("bx_abcdefgh")
const snapshot = Schema.decodeSync(SnapshotReference)({
  id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
  boxId: sourceBoxId,
  generation: 7,
  completedAt: "2026-09-09T12:00:00Z",
  sizeBytes: 4_096,
  fileCount: 32,
})
const binding = Schema.decodeSync(OrbWorkspaceBinding)({
  workspaceId: "workspace-runtime-box",
  assignmentId: "assignment-runtime-box",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace-runtime-box", lineageId: "lineage-runtime-box" },
  buildId: "executor-build-v2",
  protocolVersion: 1,
})
const policy = Schema.decodeSync(LifecyclePolicy)({
  template: { sourceBoxId, snapshotId: snapshot.id },
  ttlSeconds: 3_600,
  readinessAttempts: 2,
  readinessDelayMillis: 0,
})
const intent = Schema.decodeSync(WorkspaceLifecycleIntent)({
  _tag: "Prepare",
  intentId: "prepare-runtime-1",
  acceptedInputId: "accepted-runtime-input-1",
  template: policy.template,
  binding,
  request: {
    sourceBoxId,
    idempotencyKey: "prepare-runtime-key-1",
    issuedAtMillis: 0,
    expiresAtMillis: idempotencyWindowMillis,
    body: { noEnv: true, env: {}, ttlSeconds: policy.ttlSeconds },
  },
})
const agent = Agent.make({
  name: "box-lifecycle-runtime",
  input: Schema.String,
  output: Schema.String,
  toolkit: boxWorkspaceLifecycleToolkit,
  toolExecution: "inline",
})

const archivedSource = {
  id: sourceBoxId,
  state: "archived" as const,
  snapshotAvailable: true,
  snapshotCompletedAt: snapshot.completedAt,
  setupStatus: null,
  environment: null,
}
const readyWorkspace = {
  id: workspaceBoxId,
  state: "ready" as const,
  snapshotAvailable: false,
  setupStatus: null,
  environment: null,
}

const runtimeLayer = (simulator: DurabilityTesting.Simulator) =>
  durabilityLayer({
    environment: "box-executor-v2-test",
    tenant: "owner",
    partition: "thread-box-runtime",
    addresses: [],
  }).pipe(
    Layer.provide(ExecutableResolver.layerStatic([])),
    Layer.provide(DurabilityTesting.layer(simulator)),
    Layer.provide(BunCrypto.layer),
  )

const drain = Effect.gen(function* () {
  const scheduler = yield* LocalScheduler.LocalScheduler
  yield* scheduler.drain({ fuel: 32 })
  yield* scheduler.drain({ fuel: 32 })
  yield* scheduler.drain({ fuel: 32 })
})

const applicationLayer = (
  provider: BoxProviderService,
  forkCount: Ref.Ref<number>,
  enrollmentCount: Ref.Ref<number>,
) => {
  const providerLayer = Layer.succeed(
    BoxProvider,
    BoxProvider.of({
      ...provider,
      fork: (request) => Ref.update(forkCount, (count) => count + 1).pipe(Effect.andThen(provider.fork(request))),
    }),
  )
  const enrollmentLayer = workspaceEnrollmentLayer({
    enroll: () => Ref.update(enrollmentCount, (count) => count + 1),
    handshake: (_boxId, admitted) => Effect.succeed(toEvidence(admitted)),
  })
  const checkpointLayer = workspaceCheckpointLayer({ quiesce: () => Effect.void, flush: () => Effect.void })
  const lifecycleLayer = boxWorkspaceLifecycleLayer(policy).pipe(
    Layer.provide(Layer.mergeAll(providerLayer, enrollmentLayer, checkpointLayer)),
  )
  return Layer.mergeAll(
    lifecycleLayer,
    boxWorkspaceLifecycleToolLayer.pipe(Layer.provide(lifecycleLayer)),
    Permissions.layerAllowAll,
    Approvals.layerAutoApprove,
  )
}

const provider: BoxProviderService = {
  create: () => Effect.die("create is not used by pinned lifecycle preparation"),
  fork: () => Effect.succeed(readyWorkspace),
  resume: (request) => Effect.succeed({ ...readyWorkspace, id: request.boxId }),
  stop: (request) => Effect.succeed({ ...archivedSource, id: request.boxId }),
  get: (boxId) => Effect.succeed(boxId === sourceBoxId ? archivedSource : readyWorkspace),
  latestSnapshot: (boxId) => Effect.succeed(boxId === sourceBoxId ? snapshot : null),
}

const NestedInput = Schema.Struct({ kind: Schema.String, ordinal: Schema.Int, payload: Schema.Unknown })

const retainedLifecycle = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* RunStore.RunStore
    const journal = yield* store.recoveryJournal(runId)
    const records = yield* Effect.forEach(journal.operations, (operation) =>
      store.getOperation({ runId, operationId: operation.operationId }),
    )
    const nested = yield* Effect.forEach(
      records.filter((record) => record.kind === "nested"),
      (record) => Schema.decodeUnknownEffect(NestedInput)(record.input),
    )
    const create = nested.find((operation) => operation.kind === "rika.box.prepare-fork")
    const persistedRequest = yield* Schema.decodeUnknownEffect(ForkRequest)(create?.payload)
    const tool = records.find((record) => record.kind === "tool")
    const toolOutcome = yield* Schema.decodeUnknownEffect(ToolExecutor.Outcome)(tool?.result)
    if (toolOutcome._tag !== "Success") return yield* Effect.die("Box lifecycle tool did not succeed")
    const outcome = yield* Schema.decodeUnknownEffect(WorkspaceLifecycleOutcome)(toolOutcome.encodedResult)
    return { persistedRequest, outcome }
  })

it.effect(
  "retains exact lifecycle intent and outcome across a real Generalist Agent close and reopen",
  () =>
    Effect.gen(function* () {
      const simulator = yield* DurabilityTesting.make()
      const forks = yield* Ref.make(0)
      const enrollments = yield* Ref.make(0)
      const first = yield* Effect.gen(function* () {
        const host = yield* Host.make({
          agents: { [agent.name]: agent },
          revision: "box-executor-v2-runtime",
        })
        yield* activate
        const session = yield* host.sessions.create({ id: "session-box-runtime", agent: agent.name })
        const run = yield* host.runs.start(session.id, agent, "prepare the accepted Orb input")
        yield* drain
        expect(yield* run.await).toBe("prepared")
        const retained = yield* retainedLifecycle(run.id)
        expect(retained.persistedRequest).toEqual(intent.request)
        expect(retained.outcome).toMatchObject({ _tag: "Ready", lifecycle: "prepared", binding })
        return { runId: run.id, outcome: retained.outcome }
      }).pipe(
        provideLayer(
          Layer.mergeAll(
            runtimeLayer(simulator),
            applicationLayer(provider, forks, enrollments),
            TestModel.layer([
              TestModel.turn([
                TestModel.toolCall(boxWorkspaceLifecycleTool.name, intent, { id: "prepare-runtime-tool" }),
              ]),
              TestModel.turn([TestModel.text("prepared")]),
            ]),
          ),
        ),
      )
      expect(yield* Ref.get(forks)).toBe(1)
      expect(yield* Ref.get(enrollments)).toBe(1)
      yield* TestClock.setTime(idempotencyWindowMillis)

      yield* Effect.gen(function* () {
        const host = yield* Host.make({
          agents: { [agent.name]: agent },
          revision: "box-executor-v2-runtime",
        })
        yield* activate
        const reopened = yield* host.runs.get(first.runId)
        expect(yield* reopened.await).toBe("prepared")
        expect((yield* retainedLifecycle(first.runId)).outcome).toEqual(first.outcome)
      }).pipe(
        provideLayer(
          Layer.mergeAll(runtimeLayer(simulator), applicationLayer(provider, forks, enrollments), TestModel.layer([])),
        ),
      )
      expect(yield* Ref.get(forks)).toBe(1)
      expect(yield* Ref.get(enrollments)).toBe(1)
    }),
  60_000,
)

it.effect(
  "reopens an independent lifecycle Tool Run without a model or repeated fork and enrollment",
  () =>
    Effect.gen(function* () {
      const simulator = yield* DurabilityTesting.make()
      const forks = yield* Ref.make(0)
      const enrollments = yield* Ref.make(0)

      const first = yield* Effect.gen(function* () {
        const host = yield* Host.make({
          agents: {},
          revision: "box-executor-v2-independent-runtime",
          tools: [boxWorkspaceLifecycleTool],
        })
        yield* activate
        expect(yield* host.sessions.list()).toEqual([])
        expect(yield* Ref.get(forks)).toBe(0)
        expect(yield* Ref.get(enrollments)).toBe(0)
        const run = yield* host.tools.start(boxWorkspaceLifecycleTool, intent, { commandId: "prepare-independent" })
        yield* drain
        expect(yield* run.await).toMatchObject({ _tag: "Ready", lifecycle: "prepared", binding })
        expect(yield* run.inspect).toMatchObject({ status: "succeeded" })
        const retained = yield* retainedLifecycle(run.id)
        expect(retained.persistedRequest).toEqual(intent.request)
        return { runId: run.id, retained }
      }).pipe(provideLayer(Layer.merge(runtimeLayer(simulator), applicationLayer(provider, forks, enrollments))))

      expect(yield* Ref.get(forks)).toBe(1)
      expect(yield* Ref.get(enrollments)).toBe(1)
      yield* TestClock.setTime(idempotencyWindowMillis + 1)
      yield* Effect.gen(function* () {
        const host = yield* Host.make({
          agents: {},
          revision: "box-executor-v2-independent-runtime",
          tools: [boxWorkspaceLifecycleTool],
        })
        yield* activate
        const repeated = yield* host.tools.start(boxWorkspaceLifecycleTool, intent, {
          commandId: "prepare-independent",
        })
        expect(repeated.id).toBe(first.runId)
        expect(yield* repeated.await).toEqual(first.retained.outcome)
        expect(yield* retainedLifecycle(repeated.id)).toEqual(first.retained)
        expect(yield* host.sessions.list()).toEqual([])
      }).pipe(provideLayer(Layer.merge(runtimeLayer(simulator), applicationLayer(provider, forks, enrollments))))
      expect(yield* Ref.get(forks)).toBe(1)
      expect(yield* Ref.get(enrollments)).toBe(1)
    }),
  60_000,
)
