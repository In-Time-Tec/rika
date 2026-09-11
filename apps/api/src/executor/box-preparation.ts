import { DateTime, Effect, Option, Schema } from "effect"
import { NestedOperation, Pins, ToolContext } from "generalist"
import { ContextMaterializationError } from "@rika/context"
import {
  HandshakeEvidence,
  sameBinding,
  sameWorkspacePolicy,
  validateHandshake,
  type WorkspaceBinding,
} from "@rika/execution"
import {
  Box,
  BoxId,
  BoxProviderError,
  PrepareIntent,
  ResumeIntent,
  SnapshotReference,
  WorkspaceEnrollmentError,
  WorkspaceLifecycleError,
  idempotencyWindowMillis,
  type BoxProviderService,
  type LifecyclePolicy,
  type TemplatePin,
  type WorkspaceEnrollmentService,
} from "@rika/box-executor"
import * as BoxLifecycle from "@rika/box-executor/lifecycle"
import { BoxAssignmentProjection, type BoxAssignmentRepository } from "@rika/product-store/box-assignments"
import type { PrepareSessionContext } from "../runtime/preparation"
import { samePartition, type ThreadExecutionBinding, type ThreadPartition } from "../runtime/partition"
import { boxWorkspaceBinding } from "./box-binding"
import type { BoxWorkspaceInputEnsure } from "./box-workspace-input"

export type BoxPreparationInput = Parameters<PrepareSessionContext>[0] & {
  readonly partition: ThreadPartition
  readonly binding: ThreadExecutionBinding
}

export interface BoxPreparationOptions {
  readonly assignments: BoxAssignmentRepository
  readonly provider: BoxProviderService
  readonly enrollment: WorkspaceEnrollmentService
  readonly workspaceInput: BoxWorkspaceInputEnsure
  readonly policy: LifecyclePolicy
  readonly providerScope: string
}

export const boxTemplateBuildId = (template: TemplatePin) => `box-template:${Pins.digest(template)}`

const rejected = () =>
  ContextMaterializationError.make({
    reason: "binding",
    message: "Box preparation does not match the current assignment",
  })

const unavailable = () =>
  ContextMaterializationError.make({ reason: "reader", message: "Box workspace preparation is unavailable" })

const assertAdmitted = (input: BoxPreparationInput) =>
  Effect.gen(function* () {
    const context = yield* ToolContext.ToolContext
    if (
      input.partition.target !== "orb" ||
      !samePartition(input.partition, input.binding.partition) ||
      input.binding.placement._tag !== "Orb" ||
      input.binding.workspaceBinding.placement._tag !== "Orb" ||
      input.sessionId !== input.partition.rootSessionId ||
      context.sessionId !== input.sessionId ||
      context.runId !== input.runId ||
      context.operationKey !== input.operationKey ||
      input.acceptedInputId.length === 0
    )
      return yield* rejected()
  })

const rowFor = (options: BoxPreparationOptions, input: BoxPreparationInput) =>
  Effect.gen(function* () {
    const row = yield* options.assignments
      .get(input.binding.workspaceBinding.assignmentId)
      .pipe(Effect.mapError(unavailable))
    if (
      row === undefined ||
      row.ownerId !== input.partition.ownerId ||
      row.threadId !== input.partition.threadId ||
      row.lifecycle === "paused" ||
      row.lifecycle === "terminated" ||
      row.placement.providerScope !== options.providerScope ||
      row.placement.templateBuildId !== boxTemplateBuildId(options.policy.template)
    )
      return yield* rejected()
    const binding = yield* boxWorkspaceBinding(row).pipe(Effect.mapError(rejected))
    if (!sameBinding(binding, input.binding.workspaceBinding)) return yield* rejected()
    return row
  })

const assignmentEnrollment = (
  options: BoxPreparationOptions,
  expected: BoxAssignmentProjection,
  binding: WorkspaceBinding,
): WorkspaceEnrollmentService => ({
  enroll: (boxId, requested) =>
    Effect.gen(function* () {
      if (!sameBinding(binding, requested)) return yield* rejected()
      const operations = yield* Effect.serviceOption(NestedOperation.Operations)
      const toolContext = yield* Effect.serviceOption(ToolContext.ToolContext)
      if (Option.isNone(operations) || Option.isNone(toolContext))
        return yield* WorkspaceEnrollmentError.make({
          phase: "enroll",
          message: "Box workspace input durability is unavailable",
        })
      yield* operations.value
        .run(
          {
            kind: "rika.box.workspace-input",
            payload: { boxId, binding },
            replayPolicy: "provider-idempotent",
            success: Schema.Void,
            failure: ContextMaterializationError,
          },
          options.workspaceInput(expected, boxId, binding),
        )
        .pipe(Effect.provideService(ToolContext.ToolContext, toolContext.value))
      yield* options.assignments.bind({
        assignmentId: expected.assignmentId,
        generation: expected.generation,
        workspaceId: expected.workspaceId,
        placement: expected.placement,
        boxId,
      })
      yield* options.enrollment.enroll(boxId, binding)
    }).pipe(
      Effect.mapError(() =>
        WorkspaceEnrollmentError.make({ phase: "enroll", message: "Box assignment enrollment failed" }),
      ),
    ),
  handshake: options.enrollment.handshake,
})

const currentProjection = (options: BoxPreparationOptions, expected: BoxAssignmentProjection) =>
  options.assignments.get(expected.assignmentId).pipe(
    Effect.mapError(rejected),
    Effect.flatMap((current) =>
      current !== undefined && Pins.digest(current) === Pins.digest(expected)
        ? Effect.succeed(current)
        : Effect.fail(rejected()),
    ),
  )

const restore = (
  options: BoxPreparationOptions,
  input: BoxPreparationInput,
  row: BoxAssignmentProjection,
  boxId: BoxId,
  binding: WorkspaceBinding,
) =>
  Effect.gen(function* () {
    yield* input.beforeRecovery
    const snapshot = yield* NestedOperation.run(
      {
        kind: "rika.box.recovery-snapshot",
        payload: { boxId, binding },
        replayPolicy: "provider-idempotent",
        success: Schema.NullOr(SnapshotReference),
        failure: BoxProviderError,
      },
      options.provider.latestSnapshot(boxId),
    ).pipe(Effect.mapError((error) => (Schema.is(BoxProviderError)(error) ? unavailable() : error)))
    if (snapshot === null || snapshot.boxId !== boxId) return yield* rejected()
    const rotated = yield* NestedOperation.run(
      {
        kind: "rika.box.rotate-assignment",
        payload: row,
        replayPolicy: "provider-idempotent",
        success: BoxAssignmentProjection,
        failure: ContextMaterializationError,
      },
      options.assignments.rotate(row).pipe(Effect.mapError(rejected)),
    )
    yield* currentProjection(options, rotated)
    const recovered = yield* boxWorkspaceBinding(rotated).pipe(Effect.mapError(rejected))
    if (
      !sameWorkspacePolicy(binding, recovered) ||
      recovered.generation !== binding.generation + 1 ||
      recovered.assignmentId === binding.assignmentId ||
      rotated.providerInstanceId !== boxId
    )
      return yield* rejected()
    const intent = yield* Schema.decodeUnknownEffect(ResumeIntent)({
      _tag: "Resume",
      intentId: `resume:${Pins.digest({ partition: input.partition, binding, acceptedInputId: input.acceptedInputId })}`,
      source: { boxId, binding, snapshot },
      binding: recovered,
      request: { boxId, body: { noEnv: true, env: {}, ttlSeconds: options.policy.ttlSeconds } },
    }).pipe(Effect.mapError(rejected))
    yield* BoxLifecycle.makeBoxWorkspacePreparation({
      policy: options.policy,
      provider: options.provider,
      enrollment: assignmentEnrollment(options, rotated, recovered),
    })
      .resume(intent)
      .pipe(Effect.mapError((error) => (Schema.is(WorkspaceLifecycleError)(error) ? unavailable() : error)))
    return recovered
  })

export const makeBoxPreparation =
  (options: BoxPreparationOptions) =>
  (
    input: BoxPreparationInput,
  ): Effect.Effect<
    WorkspaceBinding,
    ContextMaterializationError | NestedOperation.Failure,
    NestedOperation.Operations | ToolContext.ToolContext
  > =>
    Effect.gen(function* () {
      yield* assertAdmitted(input)
      const admitted = input.binding.workspaceBinding
      const row = yield* NestedOperation.run(
        {
          kind: "rika.box.assignment-observation",
          payload: {
            partition: input.partition,
            workspaceId: admitted.workspaceId,
            placement: admitted.placement,
            buildId: admitted.buildId,
            protocolVersion: admitted.protocolVersion,
          },
          replayPolicy: "provider-idempotent",
          success: BoxAssignmentProjection,
          failure: ContextMaterializationError,
        },
        rowFor(options, input),
      )
      const binding = yield* boxWorkspaceBinding(row).pipe(Effect.mapError(rejected))
      if (!sameWorkspacePolicy(binding, admitted) || binding.generation > admitted.generation) return yield* rejected()
      const enrollment = assignmentEnrollment(options, row, binding)
      if (row.providerInstanceId !== null) {
        const boxId = yield* Schema.decodeEffect(BoxId)(row.providerInstanceId).pipe(Effect.mapError(rejected))
        const observed = yield* NestedOperation.run(
          {
            kind: "rika.box.availability-observation",
            payload: { boxId, binding },
            replayPolicy: "provider-idempotent",
            success: Box,
            failure: BoxProviderError,
          },
          options.provider.get(boxId),
        ).pipe(Effect.mapError((error) => (Schema.is(BoxProviderError)(error) ? unavailable() : error)))
        if (observed.id !== boxId || observed.setupStatus === "failed") return yield* rejected()
        if (observed.state === "archived") {
          if (!observed.snapshotAvailable) return yield* unavailable()
          return yield* restore(options, input, row, boxId, binding)
        }
        if (!["ready", "idle", "running"].includes(observed.state)) return yield* unavailable()
        yield* currentProjection(options, row)
        const evidence = yield* NestedOperation.run(
          {
            kind: "rika.box.ensure-enrolled",
            payload: { boxId, binding },
            replayPolicy: "provider-idempotent",
            success: HandshakeEvidence,
            failure: WorkspaceEnrollmentError,
          },
          enrollment.enroll(boxId, binding).pipe(Effect.andThen(enrollment.handshake(boxId, binding))),
        ).pipe(Effect.mapError((error) => (Schema.is(WorkspaceEnrollmentError)(error) ? unavailable() : error)))
        yield* validateHandshake(binding, evidence).pipe(Effect.mapError(rejected))
        return binding
      }
      const admittedAt = DateTime.make(input.admittedAt)
      if (Option.isNone(admittedAt)) return yield* rejected()
      const issuedAtMillis = DateTime.toEpochMillis(admittedAt.value)
      const identity = Pins.digest({ partition: input.partition, binding, acceptedInputId: input.acceptedInputId })
      const intent = yield* Schema.decodeUnknownEffect(PrepareIntent)({
        _tag: "Prepare",
        intentId: `prepare:${identity}`,
        acceptedInputId: input.acceptedInputId,
        template: options.policy.template,
        binding,
        request: {
          idempotencyKey: `rika-prepare:${identity}`,
          sourceBoxId: options.policy.template.sourceBoxId,
          issuedAtMillis,
          expiresAtMillis: issuedAtMillis + idempotencyWindowMillis,
          body: { noEnv: true, env: {}, ttlSeconds: options.policy.ttlSeconds },
        },
      }).pipe(Effect.mapError(rejected))
      const preparation = BoxLifecycle.makeBoxWorkspacePreparation({
        policy: options.policy,
        provider: options.provider,
        enrollment,
      })
      yield* preparation
        .prepare(intent)
        .pipe(Effect.mapError((error) => (Schema.is(WorkspaceLifecycleError)(error) ? unavailable() : error)))
      return binding
    })
