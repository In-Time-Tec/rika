import { Schema } from "effect"
import { ThreadId } from "../model/thread-record"
import { TurnId } from "../model/turn-record"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadInteractionRepositoryError", {
  message: Schema.String,
}) {}

export class InvocationConflict extends Schema.TaggedErrorClass<InvocationConflict>()("ThreadInvocationConflict", {
  invocationDigest: Schema.String,
}) {}

export class AdmissionRejected extends Schema.TaggedErrorClass<AdmissionRejected>()("ThreadAdmissionRejected", {
  reason: Schema.Literals([
    "source-unavailable",
    "target-unavailable",
    "self",
    "workspace",
    "archived",
    "depth",
    "admission-limit",
    "workspace-active-limit",
  ]),
  message: Schema.String,
}) {}

export class QueueFull extends Schema.TaggedErrorClass<QueueFull>()("ThreadInteractionQueueFull", {
  threadId: ThreadId,
  capacity: Schema.Int,
  count: Schema.Int,
}) {}

export class ResultNotReady extends Schema.TaggedErrorClass<ResultNotReady>()("ThreadResultNotReady", {
  targetTurnId: TurnId,
}) {}
