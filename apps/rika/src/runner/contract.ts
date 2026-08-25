import {
  RunnerRegistration as RunnerRegistrationSchema,
  RemoteThreadCreation as RemoteThreadCreationSchema,
  SanitizedRepositoryMetadata as RepositoryMetadata,
  type RunnerRegistration as RunnerRegistrationValue,
  type RunnerPollResult,
  type RemoteThreadCreation as RemoteThreadCreationValue,
} from "@rika/product/runner-registration"
import { Context, Effect, Schema } from "effect"

export const RunnerRegistration = RunnerRegistrationSchema
export type RunnerRegistration = RunnerRegistrationValue
export const RemoteThreadCreation = RemoteThreadCreationSchema
export type RemoteThreadCreation = RemoteThreadCreationValue
export { RepositoryMetadata }

export const RunnerStatus = Schema.Union([
  Schema.TaggedStruct("Registering", { registration: RunnerRegistrationSchema }),
  Schema.TaggedStruct("Waiting", { message: Schema.NonEmptyString }),
  Schema.TaggedStruct("Connecting", { workspaceIdentity: Schema.NonEmptyString }),
  Schema.TaggedStruct("Connected", { workspaceIdentity: Schema.NonEmptyString }),
  Schema.TaggedStruct("Stopped", {}),
])
export type RunnerStatus = typeof RunnerStatus.Type

export class RunnerError extends Schema.TaggedError<RunnerError>()("RunnerError", {
  message: Schema.NonEmptyString,
}) {}

export interface RunnerAdmissionInterface {
  readonly awaitAdmission: (
    registration: RunnerRegistration,
    supervisorId: string,
    status: (status: RunnerStatus) => Effect.Effect<void>,
    activeAssignmentIds: Effect.Effect<ReadonlyArray<string>>,
  ) => Effect.Effect<Exclude<RunnerPollResult, { readonly _tag: "Waiting" }>, RunnerError>
  readonly setRemoteThreadCreation: (
    registration: RunnerRegistration,
    preference: RemoteThreadCreation,
  ) => Effect.Effect<void, RunnerError>
}

export class RunnerAdmission extends Context.Service<RunnerAdmission, RunnerAdmissionInterface>()(
  "@rika/cli/runner/contract/RunnerAdmission",
) {}
