import { ExecutorFenceError, HandshakeEvidence, validateHandshake, type WorkspaceBinding } from "@rika/execution"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { NestedOperation, ToolContext } from "generalist"

import {
  Box,
  PrepareIntent,
  ResumeIntent,
  SnapshotReference,
  WorkspaceLifecycleError,
  WorkspaceLifecycleIntent,
  type BoxId,
  type ForkIntent as ForkIntentType,
  type LifecyclePolicy as LifecyclePolicyType,
  type OrbWorkspaceBinding,
  type PrepareIntent as PrepareIntentType,
  type ReadyWorkspace as ReadyWorkspaceType,
  type ResumeIntent as ResumeIntentType,
  type SnapshotReference as SnapshotReferenceType,
  type StopIntent as StopIntentType,
  type WorkspaceLifecycleIntent as WorkspaceLifecycleIntentType,
  type WorkspaceLifecycleOutcome as WorkspaceLifecycleOutcomeType,
} from "./contract"
import { lifecycleValidation } from "./lifecycle-validation"
import {
  WorkspaceCheckpoint,
  WorkspaceCheckpointError,
  WorkspaceEnrollment,
  WorkspaceEnrollmentError,
  type WorkspaceCheckpointService,
  type WorkspaceEnrollmentService,
} from "./enrollment"
import { BoxProvider, BoxProviderError, type BoxProviderService } from "./provider"

export interface BoxWorkspaceLifecycleService {
  readonly execute: (
    intent: WorkspaceLifecycleIntentType,
  ) => Effect.Effect<WorkspaceLifecycleOutcomeType, WorkspaceLifecycleError | NestedOperation.Failure>
}
export class BoxWorkspaceLifecycle extends Context.Service<BoxWorkspaceLifecycle, BoxWorkspaceLifecycleService>()(
  "@rika/box-executor/lifecycle/BoxWorkspaceLifecycle",
) {}
type Operation = WorkspaceLifecycleError["operation"]
const operationByTag = { Prepare: "prepare", Stop: "stop", Resume: "resume", Fork: "fork" } as const
const lifecycleError = (operation: Operation, kind: WorkspaceLifecycleError["kind"], message: string) =>
  WorkspaceLifecycleError.make({ operation, kind, message })
const withDurableContext = <A, E, R>(operation: Operation, execution: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const operations = yield* Effect.serviceOption(NestedOperation.Operations)
    const toolContext = yield* Effect.serviceOption(ToolContext.ToolContext)
    if (Option.isNone(operations) || Option.isNone(toolContext))
      return yield* lifecycleError(
        operation,
        "durability-unavailable",
        "Workspace lifecycle requires a Generalist durable Tool operation context",
      )
    return yield* execution.pipe(
      Effect.provideService(NestedOperation.Operations, operations.value),
      Effect.provideService(ToolContext.ToolContext, toolContext.value),
    )
  })
const fromProviderError = (operation: Operation, error: BoxProviderError): WorkspaceLifecycleError => {
  if (error.kind === "idempotency-expired")
    return lifecycleError(
      operation,
      "reconciliation-required",
      "The Box idempotency window expired without positive reconciliation evidence",
    )
  if (error.kind === "outcome-unknown" || error.kind === "retry-exhausted")
    return lifecycleError(operation, "provider-outcome-unknown", "The Box lifecycle outcome is unknown")
  return lifecycleError(operation, "provider", error.message)
}
const fromEnrollmentError = (operation: Operation, error: WorkspaceEnrollmentError): WorkspaceLifecycleError =>
  lifecycleError(operation, "enrollment", `Workspace ${error.phase} failed`)
const fromCheckpointError = (error: WorkspaceCheckpointError): WorkspaceLifecycleError =>
  lifecycleError("stop", "checkpoint", `Workspace ${error.phase} failed`)
const fromFenceError = (operation: Operation, error: ExecutorFenceError): WorkspaceLifecycleError =>
  lifecycleError(operation, "fenced", error.message)
const mapProviderFailure =
  (operation: Operation) =>
  <A, R>(effect: Effect.Effect<A, BoxProviderError | NestedOperation.Failure, R>) =>
    effect.pipe(
      Effect.mapError((error) => (Schema.is(BoxProviderError)(error) ? fromProviderError(operation, error) : error)),
    )
const mapEnrollmentFailure =
  (operation: Operation) =>
  <A, R>(effect: Effect.Effect<A, WorkspaceEnrollmentError | NestedOperation.Failure, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        Schema.is(WorkspaceEnrollmentError)(error) ? fromEnrollmentError(operation, error) : error,
      ),
    )
const nestedGet = (provider: BoxProviderService, boxId: BoxId) =>
  NestedOperation.run(
    {
      kind: "rika.box.get",
      payload: { boxId },
      replayPolicy: "provider-idempotent",
      success: Box,
      failure: BoxProviderError,
    },
    provider.get(boxId),
  )
const nestedLatestSnapshot = (provider: BoxProviderService, boxId: BoxId) =>
  NestedOperation.run(
    {
      kind: "rika.box.latest-snapshot",
      payload: { boxId },
      replayPolicy: "provider-idempotent",
      success: Schema.NullOr(SnapshotReference),
      failure: BoxProviderError,
    },
    provider.latestSnapshot(boxId),
  )
const stopWithReconciliation = (provider: BoxProviderService, intent: StopIntentType) =>
  Effect.gen(function* () {
    const stopped = yield* Effect.result(provider.stop(intent.request))
    if (stopped._tag === "Success") return stopped.success
    if (stopped.failure.kind !== "outcome-unknown") return yield* stopped.failure
    const observed = yield* Effect.result(provider.get(intent.boxId))
    if (
      observed._tag === "Success" &&
      (observed.success.state === "archiving" || observed.success.state === "archived")
    )
      return observed.success
    return yield* stopped.failure
  })

const resumeWithReconciliation = (provider: BoxProviderService, intent: ResumeIntentType) =>
  Effect.gen(function* () {
    const resumed = yield* Effect.result(provider.resume(intent.request))
    if (resumed._tag === "Success") return resumed.success
    if (resumed.failure.kind !== "outcome-unknown") return yield* resumed.failure
    const observed = yield* Effect.result(provider.get(intent.source.boxId))
    if (
      observed._tag === "Success" &&
      observed.success.state !== "archived" &&
      observed.success.state !== "archiving" &&
      observed.success.state !== "error"
    )
      return observed.success
    return yield* resumed.failure
  })

const waitForBox = (
  provider: BoxProviderService,
  policy: LifecyclePolicyType,
  operation: Operation,
  boxId: BoxId,
  target: "ready" | "archived",
) => {
  const poll = (attempt: number): Effect.Effect<Box, BoxProviderError | WorkspaceLifecycleError> =>
    provider.get(boxId).pipe(
      Effect.flatMap((box) => {
        if (target === "ready" && (box.state === "ready" || box.state === "idle" || box.state === "running"))
          return box.setupStatus === "failed"
            ? Effect.fail(lifecycleError(operation, "not-ready", "Box setup failed before workspace enrollment"))
            : Effect.succeed(box)
        if (target === "archived" && box.state === "archived") return Effect.succeed(box)
        if (box.state === "error")
          return Effect.fail(lifecycleError(operation, "not-ready", "Box entered an error state"))
        if (attempt >= policy.readinessAttempts)
          return Effect.fail(lifecycleError(operation, "not-ready", `Box did not become ${target} within the bound`))
        return Effect.sleep(policy.readinessDelayMillis).pipe(Effect.andThen(poll(attempt + 1)))
      }),
    )
  return NestedOperation.run(
    {
      kind: target === "ready" ? "rika.box.await-ready" : "rika.box.await-archived",
      payload: {
        boxId,
        target,
        attempts: policy.readinessAttempts,
        delayMillis: policy.readinessDelayMillis,
      },
      replayPolicy: "provider-idempotent",
      success: Box,
      failure: Schema.Union([BoxProviderError, WorkspaceLifecycleError]),
    },
    poll(1),
  ).pipe(Effect.mapError((error) => (Schema.is(BoxProviderError)(error) ? fromProviderError(operation, error) : error)))
}

const verifyPinnedSnapshot = (
  provider: BoxProviderService,
  operation: Operation,
  boxId: BoxId,
  snapshotId: SnapshotReferenceType["id"],
) =>
  Effect.gen(function* () {
    const box = yield* nestedGet(provider, boxId).pipe(mapProviderFailure(operation))
    if (box.state !== "archived")
      return yield* lifecycleError(
        operation,
        "snapshot-mismatch",
        "A pinned Box source must remain archived while it is restored",
      )
    const latest = yield* nestedLatestSnapshot(provider, boxId).pipe(mapProviderFailure(operation))
    if (latest === null || latest.id !== snapshotId || latest.boxId !== boxId)
      return yield* lifecycleError(operation, "snapshot-mismatch", "The latest Box snapshot does not match the pin")
    return latest
  })

const enrollmentPayload = (boxId: BoxId, binding: WorkspaceBinding) => ({ boxId, binding })

const enrollAndFence = (
  enrollment: WorkspaceEnrollmentService,
  operation: Operation,
  boxId: BoxId,
  binding: OrbWorkspaceBinding,
) =>
  Effect.gen(function* () {
    const payload = enrollmentPayload(boxId, binding)
    yield* NestedOperation.run(
      {
        kind: "rika.box.workspace-enroll",
        payload,
        replayPolicy: "never",
        success: Schema.Void,
        failure: WorkspaceEnrollmentError,
      },
      enrollment.enroll(boxId, binding),
    ).pipe(mapEnrollmentFailure(operation))
    const evidence = yield* NestedOperation.run(
      {
        kind: "rika.box.workspace-handshake",
        payload,
        replayPolicy: "provider-idempotent",
        success: HandshakeEvidence,
        failure: WorkspaceEnrollmentError,
      },
      enrollment.handshake(boxId, binding),
    ).pipe(mapEnrollmentFailure(operation))
    yield* validateHandshake(binding, evidence).pipe(Effect.mapError((error) => fromFenceError(operation, error)))
    return evidence
  })

const ready = (
  lifecycle: "prepared" | "resumed" | "forked",
  intentId: string,
  boxId: BoxId,
  binding: OrbWorkspaceBinding,
  evidence: HandshakeEvidence,
): ReadyWorkspaceType => ({ _tag: "Ready", lifecycle, intentId, boxId, binding, evidence })

const prepareWorkspace = (
  policy: LifecyclePolicyType,
  provider: BoxProviderService,
  enrollment: WorkspaceEnrollmentService,
  intent: PrepareIntentType,
) =>
  Effect.gen(function* () {
    yield* lifecycleValidation.prepare(lifecycleError, policy, intent)
    yield* verifyPinnedSnapshot(provider, "prepare", intent.template.sourceBoxId, intent.template.snapshotId)
    const created = yield* NestedOperation.run(
      {
        kind: "rika.box.prepare-fork",
        payload: intent.request,
        replayPolicy: "provider-idempotent",
        success: Box,
        failure: BoxProviderError,
      },
      provider.fork(intent.request),
    ).pipe(mapProviderFailure("prepare"))
    yield* verifyPinnedSnapshot(provider, "prepare", intent.template.sourceBoxId, intent.template.snapshotId)
    yield* waitForBox(provider, policy, "prepare", created.id, "ready")
    const evidence = yield* enrollAndFence(enrollment, "prepare", created.id, intent.binding)
    return ready("prepared", intent.intentId, created.id, intent.binding, evidence)
  })

const stopWorkspace = (
  policy: LifecyclePolicyType,
  provider: BoxProviderService,
  checkpoint: WorkspaceCheckpointService,
  intent: StopIntentType,
) =>
  Effect.gen(function* () {
    yield* lifecycleValidation.stop(lifecycleError, intent)
    const checkpointPayload = { checkpointIntentId: intent.checkpointIntentId, binding: intent.binding }
    yield* NestedOperation.run(
      {
        kind: "rika.box.workspace-quiesce",
        payload: checkpointPayload,
        replayPolicy: "never",
        success: Schema.Void,
        failure: WorkspaceCheckpointError,
      },
      checkpoint.quiesce(intent.binding),
    ).pipe(
      Effect.mapError((error) => (Schema.is(WorkspaceCheckpointError)(error) ? fromCheckpointError(error) : error)),
    )
    yield* NestedOperation.run(
      {
        kind: "rika.box.workspace-flush",
        payload: checkpointPayload,
        replayPolicy: "never",
        success: Schema.Void,
        failure: WorkspaceCheckpointError,
      },
      checkpoint.flush(intent.binding),
    ).pipe(
      Effect.mapError((error) => (Schema.is(WorkspaceCheckpointError)(error) ? fromCheckpointError(error) : error)),
    )
    yield* NestedOperation.run(
      {
        kind: "rika.box.stop",
        payload: intent.request,
        replayPolicy: "never",
        success: Box,
        failure: BoxProviderError,
      },
      stopWithReconciliation(provider, intent),
    ).pipe(mapProviderFailure("stop"))
    yield* waitForBox(provider, policy, "stop", intent.boxId, "archived")
    const snapshot = yield* nestedLatestSnapshot(provider, intent.boxId).pipe(mapProviderFailure("stop"))
    if (snapshot === null || snapshot.boxId !== intent.boxId)
      return yield* lifecycleError("stop", "snapshot-mismatch", "Box archived without a confirmed snapshot reference")
    return {
      _tag: "Stopped" as const,
      intentId: intent.intentId,
      boxId: intent.boxId,
      binding: intent.binding,
      snapshot,
    }
  })

const resumeWorkspace = (
  policy: LifecyclePolicyType,
  provider: BoxProviderService,
  enrollment: WorkspaceEnrollmentService,
  intent: ResumeIntentType,
) =>
  Effect.gen(function* () {
    yield* lifecycleValidation.resume(lifecycleError, policy, intent)
    yield* verifyPinnedSnapshot(provider, "resume", intent.source.boxId, intent.source.snapshot.id)
    yield* NestedOperation.run(
      {
        kind: "rika.box.resume",
        payload: intent.request,
        replayPolicy: "never",
        success: Box,
        failure: BoxProviderError,
      },
      resumeWithReconciliation(provider, intent),
    ).pipe(mapProviderFailure("resume"))
    yield* waitForBox(provider, policy, "resume", intent.source.boxId, "ready")
    const evidence = yield* enrollAndFence(enrollment, "resume", intent.source.boxId, intent.binding)
    return ready("resumed", intent.intentId, intent.source.boxId, intent.binding, evidence)
  })

const forkWorkspace = (
  policy: LifecyclePolicyType,
  provider: BoxProviderService,
  enrollment: WorkspaceEnrollmentService,
  intent: ForkIntentType,
) =>
  Effect.gen(function* () {
    yield* lifecycleValidation.fork(lifecycleError, policy, intent)
    yield* verifyPinnedSnapshot(provider, "fork", intent.source.boxId, intent.source.snapshot.id)
    const forked = yield* NestedOperation.run(
      {
        kind: "rika.box.fork",
        payload: intent.request,
        replayPolicy: "provider-idempotent",
        success: Box,
        failure: BoxProviderError,
      },
      provider.fork(intent.request),
    ).pipe(mapProviderFailure("fork"))
    yield* verifyPinnedSnapshot(provider, "fork", intent.source.boxId, intent.source.snapshot.id)
    yield* waitForBox(provider, policy, "fork", forked.id, "ready")
    const evidence = yield* enrollAndFence(enrollment, "fork", forked.id, intent.binding)
    return ready("forked", intent.intentId, forked.id, intent.binding, evidence)
  })

export interface MakeBoxWorkspaceLifecycleOptions {
  readonly policy: LifecyclePolicyType
  readonly provider: BoxProviderService
  readonly enrollment: WorkspaceEnrollmentService
  readonly checkpoint: WorkspaceCheckpointService
}

export const makeBoxWorkspacePreparation = (options: Omit<MakeBoxWorkspaceLifecycleOptions, "checkpoint">) => ({
  prepare: (unvalidated: PrepareIntentType) =>
    Schema.decodeEffect(PrepareIntent)(unvalidated).pipe(
      Effect.mapError(() => lifecycleError("prepare", "invalid-intent", "Workspace prepare intent was invalid")),
      Effect.flatMap((intent) =>
        withDurableContext("prepare", prepareWorkspace(options.policy, options.provider, options.enrollment, intent)),
      ),
    ),
  resume: (unvalidated: ResumeIntentType) =>
    Schema.decodeEffect(ResumeIntent)(unvalidated).pipe(
      Effect.mapError(() => lifecycleError("resume", "invalid-intent", "Workspace resume intent was invalid")),
      Effect.flatMap((intent) =>
        withDurableContext("resume", resumeWorkspace(options.policy, options.provider, options.enrollment, intent)),
      ),
    ),
})

export const makeBoxWorkspaceLifecycle = (options: MakeBoxWorkspaceLifecycleOptions): BoxWorkspaceLifecycleService => ({
  execute: (unvalidated) =>
    Schema.decodeEffect(WorkspaceLifecycleIntent)(unvalidated).pipe(
      Effect.mapError(() => lifecycleError("prepare", "invalid-intent", "Workspace lifecycle intent was invalid")),
      Effect.flatMap((intent) => {
        const execution = (() => {
          switch (intent._tag) {
            case "Prepare":
              return prepareWorkspace(options.policy, options.provider, options.enrollment, intent)
            case "Stop":
              return stopWorkspace(options.policy, options.provider, options.checkpoint, intent)
            case "Resume":
              return resumeWorkspace(options.policy, options.provider, options.enrollment, intent)
            case "Fork":
              return forkWorkspace(options.policy, options.provider, options.enrollment, intent)
          }
        })()
        return withDurableContext<
          WorkspaceLifecycleOutcomeType,
          WorkspaceLifecycleError | NestedOperation.Failure,
          NestedOperation.Operations | ToolContext.ToolContext
        >(operationByTag[intent._tag], execution)
      }),
    ),
})

export const boxWorkspaceLifecycleLayer = (
  policy: LifecyclePolicyType,
): Layer.Layer<BoxWorkspaceLifecycle, never, BoxProvider | WorkspaceEnrollment | WorkspaceCheckpoint> =>
  Layer.effect(
    BoxWorkspaceLifecycle,
    Effect.gen(function* () {
      const provider = yield* BoxProvider
      const enrollment = yield* WorkspaceEnrollment
      const checkpoint = yield* WorkspaceCheckpoint
      return BoxWorkspaceLifecycle.of(makeBoxWorkspaceLifecycle({ policy, provider, enrollment, checkpoint }))
    }),
  )
