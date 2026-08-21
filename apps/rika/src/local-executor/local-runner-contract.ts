import type { LocalExecutorAdmissionWire } from "@rika/remote-execution/protocol"
import { Context, Effect, Schema } from "effect"

export const RemoteThreadCreation = Schema.Literals(["denied", "allowed"])
export type RemoteThreadCreation = typeof RemoteThreadCreation.Type

export const RepositoryMetadata = Schema.Struct({
  identity: Schema.NonEmptyString,
  remoteUrl: Schema.optionalKey(Schema.NonEmptyString),
  headRevision: Schema.optionalKey(Schema.NonEmptyString),
  branch: Schema.optionalKey(Schema.NonEmptyString),
})
export type RepositoryMetadata = typeof RepositoryMetadata.Type

export const LocalRunnerRegistration = Schema.Struct({
  deviceId: Schema.NonEmptyString,
  checkoutFingerprint: Schema.NonEmptyString,
  repository: RepositoryMetadata,
  workspaceIdentity: Schema.NonEmptyString,
  kernel: Schema.Struct({
    runtime: Schema.Literal("bun"),
    runtimeVersion: Schema.NonEmptyString,
    trustMode: Schema.Literal("trusted-local"),
  }),
  capabilities: Schema.Struct({
    cells: Schema.Literal(true),
    checkpoints: Schema.Boolean,
    pty: Schema.Boolean,
  }),
  remoteThreadCreation: RemoteThreadCreation,
})
export type LocalRunnerRegistration = typeof LocalRunnerRegistration.Type

export const LocalRunnerStatus = Schema.Union([
  Schema.TaggedStruct("Registering", { registration: LocalRunnerRegistration }),
  Schema.TaggedStruct("Waiting", { message: Schema.NonEmptyString }),
  Schema.TaggedStruct("Connecting", { workspaceIdentity: Schema.NonEmptyString }),
  Schema.TaggedStruct("Connected", { workspaceIdentity: Schema.NonEmptyString }),
  Schema.TaggedStruct("Stopped", {}),
])
export type LocalRunnerStatus = typeof LocalRunnerStatus.Type

export class LocalRunnerError extends Schema.TaggedError<LocalRunnerError>()("LocalRunnerError", {
  message: Schema.NonEmptyString,
}) {}

export interface LocalRunnerAdmissionInterface {
  readonly awaitAdmission: (
    registration: LocalRunnerRegistration,
    status: (status: LocalRunnerStatus) => Effect.Effect<void>,
  ) => Effect.Effect<LocalExecutorAdmissionWire, LocalRunnerError>
  readonly setRemoteThreadCreation: (
    registration: LocalRunnerRegistration,
    preference: RemoteThreadCreation,
  ) => Effect.Effect<void, LocalRunnerError>
}

export class LocalRunnerAdmission extends Context.Service<LocalRunnerAdmission, LocalRunnerAdmissionInterface>()(
  "@rika/cli/local-executor/local-runner-contract/LocalRunnerAdmission",
) {}
