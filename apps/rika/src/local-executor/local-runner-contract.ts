import type { LocalExecutorAdmissionWire } from "@rika/remote-execution/protocol"
import {
  LocalRunnerRegistration as LocalRunnerRegistrationSchema,
  RemoteThreadCreation as RemoteThreadCreationSchema,
  SanitizedRepositoryMetadata as RepositoryMetadata,
  type LocalRunnerRegistration as LocalRunnerRegistrationValue,
  type RemoteThreadCreation as RemoteThreadCreationValue,
} from "@rika/product/local-runner-registration"
import { Context, Effect, Schema } from "effect"

export const LocalRunnerRegistration = LocalRunnerRegistrationSchema
export type LocalRunnerRegistration = LocalRunnerRegistrationValue
export const RemoteThreadCreation = RemoteThreadCreationSchema
export type RemoteThreadCreation = RemoteThreadCreationValue
export { RepositoryMetadata }

export const LocalRunnerStatus = Schema.Union([
  Schema.TaggedStruct("Registering", { registration: LocalRunnerRegistrationSchema }),
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
