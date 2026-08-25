import { Schema } from "effect"

export class StartTurnFailure extends Schema.TaggedError<StartTurnFailure>()("StartTurnFailure", {
  message: Schema.String,
}) {}
export class PrepareTurnFailure extends Schema.TaggedError<PrepareTurnFailure>()("PrepareTurnFailure", {
  kind: Schema.Literals(["invalid", "unavailable"]),
  message: Schema.String,
}) {}
export class AdmitTurnFailure extends Schema.TaggedError<AdmitTurnFailure>()("AdmitTurnFailure", {
  kind: Schema.Literals(["idempotency-conflict", "run-id-conflict", "invalid", "unavailable"]),
  message: Schema.String,
}) {}
export class ActivateTurnFailure extends Schema.TaggedError<ActivateTurnFailure>()("ActivateTurnFailure", {
  kind: Schema.Literals(["missing", "unavailable"]),
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
