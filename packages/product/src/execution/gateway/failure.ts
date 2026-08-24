import { Schema } from "effect"

export class StartTurnFailure extends Schema.TaggedError<StartTurnFailure>()("StartTurnFailure", {
  message: Schema.String,
}) {}
export class CancelTurnFailure extends Schema.TaggedError<CancelTurnFailure>()("CancelTurnFailure", {
  message: Schema.String,
}) {}
export class SteeringFailure extends Schema.TaggedError<SteeringFailure>()("SteeringFailure", {
  kind: Schema.Literals(["rejected", "unknown"]),
  message: Schema.String,
}) {}
export class WatchTurnFailure extends Schema.TaggedError<WatchTurnFailure>()("WatchTurnFailure", {
  message: Schema.String,
}) {}
export class InspectTurnFailure extends Schema.TaggedError<InspectTurnFailure>()("InspectTurnFailure", {
  message: Schema.String,
}) {}
export class ApprovalResponseFailure extends Schema.TaggedError<ApprovalResponseFailure>()("ApprovalResponseFailure", {
  kind: Schema.Literals(["stale", "mismatch", "unavailable"]),
  message: Schema.String,
}) {}
