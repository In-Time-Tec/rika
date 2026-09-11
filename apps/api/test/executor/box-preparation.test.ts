import { Effect, Encoding, Layer, Ref, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { NestedOperation, ToolContext } from "generalist"
import {
  BoxId,
  LifecyclePolicy,
  SnapshotReference,
  type BoxProviderService,
  type BoxState,
} from "@rika/box-executor"
import { BoxWorkspaceInputError } from "@rika/box-executor/workspace-input-contract"
import { WorkspaceBinding, toEvidence } from "@rika/execution"
import { ContextMaterializationError } from "@rika/context"
import { BoxAssignmentError, type BoxAssignmentProjection } from "@rika/product-store/box-assignments"
import {
  checkout,
  repositoryInput,
  seedArchive,
  workspaceInputHarness,
  workspaceSeed,
} from "./box-workspace-input.support"
import {
  boxTemplateBuildId,
  makeBoxPreparation,
  type BoxPreparationInput,
  type BoxPreparationOptions,
} from "../../src/executor/box-preparation"
import { threadPartition } from "../../src/runtime/partition"

const sourceBox = Schema.decodeSync(BoxId)("bx_23456789")
const preparedBox = Schema.decodeSync(BoxId)("bx_abcdefgh")
const assignmentId = (generation: number) =>
  `bxa_${Encoding.encodeBase64Url(JSON.stringify(["assignment", generation]))}`
const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace",
  assignmentId: assignmentId(1),
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
  buildId: "build",
  protocolVersion: 1,
})
const snapshot = Schema.decodeSync(SnapshotReference)({
  id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
  boxId: sourceBox,
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
const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "orb" })
const input: BoxPreparationInput = {
  partition,
  binding: { partition, placement: binding.placement, workspaceBinding: binding },
  sessionId: partition.rootSessionId,
  runId: "run",
  operationKey: "operation",
  acceptedInputId: "accepted-input",
  admittedAt: "2026-09-10T00:00:00Z",
  beforeRecovery: Effect.void,
}

const withContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(
      Layer.merge(
        NestedOperation.layerDirect,
        ToolContext.layerTest({
          signal: new AbortController().signal,
          emit: () => Effect.succeed(false),
          sessionId: input.sessionId,
          runId: input.runId,
          operationKey: input.operationKey,
        }),
      ),
    ).pipe(Effect.flatMap((services) => Effect.provide(effect, services))),
  )

const fixture = (
  workspaceInput: (events: Array<string>) => BoxPreparationOptions["workspaceInput"] = () => () => Effect.void,
) =>
  Effect.gen(function* () {
    const current = yield* Ref.make<BoxAssignmentProjection>({
      assignmentId: binding.assignmentId,
      ownerId: "owner",
      threadId: "thread",
      workspaceId: binding.workspaceId,
      generation: 1,
      lifecycle: "pending",
      providerInstanceId: null,
      checkout: null,
      workspaceSeed: null,
      placement: {
        _tag: "OrbPlacement",
        lineageId: "lineage",
        templateBuildId: boxTemplateBuildId(policy.template),
        providerScope: "scope",
        executorPolicy: { buildId: "build", protocolVersion: 1 },
      },
    })
    const events: string[] = []
    const forks: Parameters<BoxProviderService["fork"]>[0][] = []
    const resumes: Parameters<BoxProviderService["resume"]>[0][] = []
    const state = yield* Ref.make<BoxState>("ready")
    const unused = () => Effect.die("Preparation must not use destructive or unpinned provider operations")
    const prepare = makeBoxPreparation({
      assignments: {
        get: () => Ref.get(current),
        bind: (request) =>
          Effect.sync(() => events.push("bind")).pipe(
            Effect.andThen(Ref.updateAndGet(current, (row) => ({ ...row, providerInstanceId: request.boxId }))),
          ),
        rotate: (expected) =>
          Effect.gen(function* () {
            const row = yield* Ref.get(current)
            if (row.assignmentId !== expected.assignmentId || row.generation !== expected.generation)
              return yield* BoxAssignmentError.make({ reason: "stale-fence", message: "Assignment changed" })
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
      provider: {
        create: unused,
        resume: (request) =>
          Effect.gen(function* () {
            events.push("resume")
            resumes.push(request)
            yield* Ref.set(state, "ready")
            return { id: request.boxId, state: "ready" as const, snapshotAvailable: true }
          }),
        stop: unused,
        fork: (request) =>
          Effect.sync(() => {
            events.push("fork")
            forks.push(request)
            return { id: preparedBox, state: "ready" as const, snapshotAvailable: false }
          }),
        get: (id) =>
          Ref.get(state).pipe(
            Effect.map((observedState) => ({
              id,
              state: id === sourceBox ? ("archived" as const) : observedState,
              snapshotAvailable: id === sourceBox || observedState === "archived",
            })),
          ),
        latestSnapshot: (boxId) => Effect.succeed({ ...snapshot, boxId }),
      },
      workspaceInput: workspaceInput(events),
      enrollment: {
        enroll: () =>
          Effect.sync(() => {
            events.push("enroll")
          }),
        handshake: (_boxId, expected) =>
          Effect.sync(() => {
            events.push("handshake")
            return toEvidence(expected)
          }),
      },
    })
    return { prepare, current, events, forks, resumes, state }
  })

it.effect(
  "allocates only after admitted preparation, binds product metadata before enrollment, and pins the request",
  () =>
    withContext(
      Effect.gen(function* () {
        const test = yield* fixture()
        expect(test.events).toEqual([])
        yield* test.prepare(input)
        expect(test.events).toEqual(["fork", "bind", "enroll", "handshake"])
        expect(test.forks).toHaveLength(1)
        expect(test.forks[0]).toMatchObject({
          sourceBoxId: sourceBox,
          issuedAtMillis: 1_788_998_400_000,
          expiresAtMillis: 1_789_084_800_000,
          body: { noEnv: true, env: {}, ttlSeconds: 3_600 },
        })
        expect(test.forks[0]?.idempotencyKey).toMatch(/^rika-prepare:[a-f0-9]{64}$/)
        expect((yield* Ref.get(test.current)).providerInstanceId).toBe(preparedBox)
      }),
    ),
)

it.effect("reuses an associated Box without another provider fork", () =>
  withContext(
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* Ref.update(test.current, (row) => ({ ...row, providerInstanceId: preparedBox }))
      yield* test.prepare(input)
      expect(test.forks).toEqual([])
      expect(test.events).toEqual(["bind", "enroll", "handshake"])
    }),
  ),
)

it.effect("rejects unadmitted callers and changed product fences before touching the provider", () =>
  withContext(
    Effect.gen(function* () {
      const test = yield* fixture()
      expect(yield* Effect.result(test.prepare({ ...input, runId: "unrelated-run" }))).toMatchObject({
        _tag: "Failure",
      })
      const original = yield* Ref.get(test.current)
      const replacements: ReadonlyArray<BoxAssignmentProjection> = [
        { ...original, ownerId: "other-owner" },
        { ...original, threadId: "other-thread" },
        { ...original, generation: 2 },
        { ...original, lifecycle: "paused" },
        { ...original, lifecycle: "terminated" },
        { ...original, placement: { ...original.placement, providerScope: "other-scope" } },
        { ...original, placement: { ...original.placement, templateBuildId: "other-template" } },
      ]
      for (const replacement of replacements) {
        yield* Ref.set(test.current, replacement)
        expect(yield* Effect.result(test.prepare(input))).toMatchObject({ _tag: "Failure" })
      }
      expect(test.events).toEqual([])
    }),
  ),
)

it.effect("restores an archived Box only after rotating its product fence and enrolls the fresh generation", () =>
  withContext(
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* Ref.update(test.current, (row) => ({ ...row, providerInstanceId: preparedBox }))
      yield* Ref.set(test.state, "archived")
      const recovered = yield* test.prepare(input)
      expect(recovered).toEqual({ ...binding, assignmentId: assignmentId(2), generation: 2 })
      expect(test.events).toEqual(["rotate", "resume", "bind", "enroll", "handshake"])
      expect(test.forks).toEqual([])
      expect(test.resumes).toEqual([
        {
          boxId: preparedBox,
          body: { noEnv: true, env: {}, ttlSeconds: 3_600 },
        },
      ])
      expect(yield* Ref.get(test.current)).toMatchObject({
        assignmentId: recovered.assignmentId,
        generation: 2,
        providerInstanceId: preparedBox,
      })
      expect(yield* Effect.result(test.prepare(input))).toMatchObject({ _tag: "Failure" })
      expect(test.resumes).toHaveLength(1)
      const continued = yield* test.prepare({
        ...input,
        binding: { ...input.binding, workspaceBinding: recovered },
      })
      expect(continued).toEqual(recovered)
      expect(test.resumes).toHaveLength(1)
    }),
  ),
)

it.effect("refuses incomplete archive and unhealthy provider states without rotating or restarting", () =>
  withContext(
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* Ref.update(test.current, (row) => ({ ...row, providerInstanceId: preparedBox }))
      for (const state of ["archiving", "error", "init", "provisioning"] as const) {
        yield* Ref.set(test.state, state)
        expect(yield* Effect.result(test.prepare(input))).toMatchObject({ _tag: "Failure" })
      }
      expect(test.events).toEqual([])
      expect(test.resumes).toEqual([])
      expect((yield* Ref.get(test.current)).generation).toBe(1)
    }),
  ),
)

it.effect("rejects recovery obligations before changing the assignment fence or resuming the provider", () =>
  withContext(
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* Ref.update(test.current, (row) => ({ ...row, providerInstanceId: preparedBox }))
      yield* Ref.set(test.state, "archived")
      expect(
        yield* Effect.result(
          test.prepare({
            ...input,
            beforeRecovery: ContextMaterializationError.make({
              reason: "binding",
              message: "Unresolved native operation",
            }),
          }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect(test.events).toEqual([])
      expect(test.resumes).toEqual([])
      expect((yield* Ref.get(test.current)).generation).toBe(1)
    }),
  ),
)

it.effect("materializes workspace input on a fresh Box before binding and enrolling", () =>
  withContext(
    Effect.gen(function* () {
      let harness!: ReturnType<typeof workspaceInputHarness>
      const test = yield* fixture((events) => {
        harness = workspaceInputHarness(events, { inspect: false })
        return harness.ensure
      })
      yield* Ref.update(test.current, (row) => ({ ...row, checkout, workspaceSeed }))
      yield* test.prepare(input)
      expect(test.events).toEqual(["fork", "inspect", "capture", "vault", "materialize", "bind", "enroll", "handshake"])
      expect(harness.materialized).toEqual([{ repository: repositoryInput.archive, seed: seedArchive }])
      expect(harness.policies[0]?.checkout).toMatchObject({ commitSha: checkout.commitSha })
      expect(harness.policies[0]?.seed).toEqual({
        id: workspaceSeed.id,
        sourceRepository: workspaceSeed.sourceRepository,
        archiveDigest: workspaceSeed.archiveDigest,
        archiveSizeBytes: workspaceSeed.archiveSizeBytes,
      })
    }),
  ),
)

it.effect("uploads nothing before binding when the Box receipt already matches the policy", () =>
  withContext(
    Effect.gen(function* () {
      let harness!: ReturnType<typeof workspaceInputHarness>
      const test = yield* fixture((events) => {
        harness = workspaceInputHarness(events, { inspect: true })
        return harness.ensure
      })
      yield* test.prepare(input)
      expect(test.events).toEqual(["fork", "inspect", "bind", "enroll", "handshake"])
      expect(harness.materialized).toEqual([])
      expect(harness.captured).toEqual([])
      expect(harness.loaded).toEqual([])
    }),
  ),
)

it.effect("materializes a bound but uninitialized Box before enrolling the Runner daemon", () =>
  withContext(
    Effect.gen(function* () {
      let harness!: ReturnType<typeof workspaceInputHarness>
      const test = yield* fixture((events) => {
        harness = workspaceInputHarness(events, { inspect: false })
        return harness.ensure
      })
      yield* Ref.update(test.current, (row) => ({ ...row, providerInstanceId: preparedBox, checkout }))
      yield* test.prepare(input)
      expect(test.events).toEqual(["inspect", "capture", "materialize", "bind", "enroll", "handshake"])
      expect(harness.loaded).toEqual([])
    }),
  ),
)

it.effect("validates the existing receipt on resume without reapplying the workspace seed", () =>
  withContext(
    Effect.gen(function* () {
      let harness!: ReturnType<typeof workspaceInputHarness>
      const test = yield* fixture((events) => {
        harness = workspaceInputHarness(events, { inspect: true })
        return harness.ensure
      })
      yield* Ref.update(test.current, (row) => ({ ...row, providerInstanceId: preparedBox, checkout, workspaceSeed }))
      yield* Ref.set(test.state, "archived")
      yield* test.prepare(input)
      expect(test.events).toEqual(["rotate", "resume", "inspect", "bind", "enroll", "handshake"])
      expect(harness.materialized).toEqual([])
      expect(harness.captured).toEqual([])
      expect(harness.loaded).toEqual([])
      expect(harness.policies[0]?.seed).toEqual({
        id: workspaceSeed.id,
        sourceRepository: workspaceSeed.sourceRepository,
        archiveDigest: workspaceSeed.archiveDigest,
        archiveSizeBytes: workspaceSeed.archiveSizeBytes,
      })
    }),
  ),
)

it.effect("fails preparation before binding when workspace materialization conflicts", () =>
  withContext(
    Effect.gen(function* () {
      const test = yield* fixture(
        (events) =>
          workspaceInputHarness(events, {
            inspect: false,
            materializeError: BoxWorkspaceInputError.make({ reason: "conflict", message: "occupied" }),
          }).ensure,
      )
      expect(yield* Effect.result(test.prepare(input))).toMatchObject({ _tag: "Failure" })
      expect(test.events).toEqual(["fork", "inspect", "materialize"])
      expect((yield* Ref.get(test.current)).providerInstanceId).toBeNull()
    }),
  ),
)
