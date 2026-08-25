import { Schema } from "effect"
import { ExecutionRouteSnapshot } from "../route/snapshot"
import { Checkpoint } from "../projection/contract"
import { PromptPart } from "../request"
import { ReviewIntent } from "../review-intent"

export const ExecutionLink = Schema.Struct({
  runId: Schema.String,
  titleRunId: Schema.optionalKey(Schema.String),
  turnId: Schema.String,
  threadId: Schema.String,
})
export type ExecutionLink = typeof ExecutionLink.Type

export const StartTurn = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  workspaceId: Schema.NonEmptyString,
  prompt: Schema.String,
  promptParts: Schema.optionalKey(Schema.Array(PromptPart)),
  executionRoute: ExecutionRouteSnapshot,
  titleIntent: Schema.optionalKey(Schema.TaggedStruct("GenerateThreadTitle", { expectedTitle: Schema.String })),
  reviewIntent: Schema.optionalKey(ReviewIntent),
})
export type StartTurn = typeof StartTurn.Type

export const PreparedTurn = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  runId: Schema.String,
  titleRunId: Schema.optionalKey(Schema.String),
  rootAdmissionJson: Schema.NonEmptyString,
  titleAdmissionJson: Schema.optionalKey(Schema.NonEmptyString),
  reviewIntent: Schema.optionalKey(ReviewIntent),
})
export type PreparedTurn = typeof PreparedTurn.Type

export const AuthorizationResponse = Schema.Struct({
  authorizationId: Schema.String,
  checkpoint: Checkpoint,
})
export type AuthorizationResponse = typeof AuthorizationResponse.Type
