import { Schema } from "effect"

export class StartTurnFailure extends Schema.TaggedErrorClass<StartTurnFailure>()("StartTurnFailure", {
  message: Schema.String,
}) {}
export class CancelTurnFailure extends Schema.TaggedErrorClass<CancelTurnFailure>()("CancelTurnFailure", {
  message: Schema.String,
}) {}
export class SteeringFailure extends Schema.TaggedErrorClass<SteeringFailure>()("SteeringFailure", {
  kind: Schema.Literals(["rejected", "unknown"]),
  message: Schema.String,
}) {}
export class WatchTurnFailure extends Schema.TaggedErrorClass<WatchTurnFailure>()("WatchTurnFailure", {
  message: Schema.String,
}) {}
export class InspectTurnFailure extends Schema.TaggedErrorClass<InspectTurnFailure>()("InspectTurnFailure", {
  message: Schema.String,
}) {}
export class ApprovalResponseFailure extends Schema.TaggedErrorClass<ApprovalResponseFailure>()(
  "ApprovalResponseFailure",
  {
    kind: Schema.Literals(["stale", "mismatch", "unavailable"]),
    message: Schema.String,
  },
) {}
