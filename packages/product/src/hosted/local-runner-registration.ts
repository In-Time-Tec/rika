import { Schema } from "effect"
import { DeviceId, ProjectId, WorkspaceId } from "./model"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
export const CheckoutFingerprint = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/)).pipe(
  Schema.brand("LocalRunnerCheckoutFingerprint"),
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

export const LocalRunnerProfile = strict(
  Schema.Struct({
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
export type LocalRunnerProfile = typeof LocalRunnerProfile.Type

export const RemoteThreadCreation = Schema.Literals(["denied", "allowed"])
export type RemoteThreadCreation = typeof RemoteThreadCreation.Type

export const LocalRunnerRegistration = strict(
  Schema.Struct({
    deviceId: DeviceId,
    checkoutFingerprint: CheckoutFingerprint,
    ...LocalRunnerProfile.fields,
    remoteThreadCreation: RemoteThreadCreation,
  }),
)
export type LocalRunnerRegistration = typeof LocalRunnerRegistration.Type

export const RemoteThreadCreationPreference = strict(Schema.Struct({ preference: RemoteThreadCreation }))
export type RemoteThreadCreationPreference = typeof RemoteThreadCreationPreference.Type

export const LocalRunnerTarget = strict(Schema.Struct({ deviceId: DeviceId, checkoutFingerprint: CheckoutFingerprint }))
export type LocalRunnerTarget = typeof LocalRunnerTarget.Type

export const LocalRunnerWaiting = Schema.TaggedStruct("Waiting", {})
export const LocalRunnerAdmitted = Schema.TaggedStruct("Admitted", {
  admissionId: Schema.String,
  ticket: Schema.String,
  expiresAt: Schema.Finite,
  executorUrl: Schema.String,
  workspaceIdentity: Schema.String,
})
export const LocalRunnerPollResult = Schema.Union([LocalRunnerWaiting, LocalRunnerAdmitted])
export type LocalRunnerPollResult = typeof LocalRunnerPollResult.Type
