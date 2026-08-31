import { Schema } from "effect"
import { DeviceId, ExecutorAssignmentId, ProjectId, WorkspaceId } from "../model"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
export const runnerProtocolVersion = 1 as const
export const CheckoutFingerprint = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/)).pipe(
  Schema.brand("RunnerCheckoutFingerprint"),
)
export type CheckoutFingerprint = typeof CheckoutFingerprint.Type

export const SanitizedRepositoryMetadata = strict(
  Schema.Struct({
    identity: Schema.NonEmptyString,
    remoteUrl: Schema.optionalKey(Schema.NonEmptyString),
    headRevision: Schema.optionalKey(Schema.NonEmptyString),
    branch: Schema.optionalKey(Schema.NonEmptyString),
  }),
)
export type SanitizedRepositoryMetadata = typeof SanitizedRepositoryMetadata.Type

export const RunnerProfile = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(runnerProtocolVersion),
    workspaceIdentity: WorkspaceId,
    projectId: Schema.optionalKey(ProjectId),
    repository: SanitizedRepositoryMetadata,
    kernel: strict(
      Schema.Struct({
        runtime: Schema.Literal("bun"),
        runtimeVersion: Schema.NonEmptyString,
        trustMode: Schema.Literal("trusted-local"),
      }),
    ),
    capabilities: strict(
      Schema.Struct({
        cells: Schema.Literal(true),
        checkpoints: Schema.Boolean,
        pty: Schema.Boolean,
      }),
    ),
  }),
)
export type RunnerProfile = typeof RunnerProfile.Type

export const RemoteThreadCreation = Schema.Literals(["denied", "allowed"])
export type RemoteThreadCreation = typeof RemoteThreadCreation.Type

export const RunnerRegistration = strict(
  Schema.Struct({
    deviceId: DeviceId,
    checkoutFingerprint: CheckoutFingerprint,
    ...RunnerProfile.fields,
    remoteThreadCreation: RemoteThreadCreation,
  }),
)
export type RunnerRegistration = typeof RunnerRegistration.Type

export const RemoteThreadCreationPreference = strict(Schema.Struct({ preference: RemoteThreadCreation }))
export type RemoteThreadCreationPreference = typeof RemoteThreadCreationPreference.Type

export const RunnerTarget = strict(Schema.Struct({ deviceId: DeviceId, checkoutFingerprint: CheckoutFingerprint }))
export type RunnerTarget = typeof RunnerTarget.Type

export const RunnerSupervisorId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
).pipe(Schema.brand("RunnerSupervisorId"))
export type RunnerSupervisorId = typeof RunnerSupervisorId.Type
export const RunnerPollRequest = strict(
  Schema.Struct({
    supervisorId: RunnerSupervisorId,
    activeAssignmentIds: Schema.Array(ExecutorAssignmentId).check(Schema.isMaxLength(64)),
  }),
)
export type RunnerPollRequest = typeof RunnerPollRequest.Type

export const RunnerWaiting = Schema.TaggedStruct("Waiting", {
  reason: Schema.Literals(["no-work", "runner-owned"]),
})
export const RunnerAdmitted = Schema.TaggedStruct("Admitted", {
  assignmentId: ExecutorAssignmentId,
  admissionId: Schema.String,
  ticket: Schema.String,
  expiresAt: Schema.Finite,
  executorUrl: Schema.String,
  workspaceIdentity: Schema.String,
})
export const RunnerResume = Schema.TaggedStruct("Resume", {
  assignmentId: ExecutorAssignmentId,
  leaseExpiresAt: Schema.Finite,
})
export const RunnerPollResult = Schema.Union([RunnerWaiting, RunnerAdmitted, RunnerResume])
export type RunnerPollResult = typeof RunnerPollResult.Type
