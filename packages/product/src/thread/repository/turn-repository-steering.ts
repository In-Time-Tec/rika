import { Schema } from "effect"
import {
  ExecutionLink,
  SteeringFailure,
  SteeringInput,
  SteeringReceipt,
} from "../../execution/contract/execution-gateway"
import { ThreadId } from "../model/thread-record"
import { AgentExecutionTurn, TurnId } from "../model/turn-record"

const QueueItemChange = Schema.Struct({
  threadId: ThreadId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  queuedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  becameNonempty: Schema.Boolean,
  change: Schema.Union([
    Schema.Struct({ _tag: Schema.tag("Added"), turn: AgentExecutionTurn }),
    Schema.Struct({ _tag: Schema.tag("Updated"), turn: AgentExecutionTurn }),
    Schema.Struct({ _tag: Schema.tag("Removed"), turnId: TurnId }),
  ]),
})

const SteeringAdmissionOutcome = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Accepted", { receipt: SteeringReceipt }),
  Schema.TaggedStruct("Rejected", {
    failure: SteeringFailure,
    queue: Schema.optionalKey(QueueItemChange),
  }),
])

export const SteeringAdmission = Schema.Struct({
  target: ExecutionLink,
  input: SteeringInput,
  source: Schema.optionalKey(AgentExecutionTurn),
  preparedAt: Schema.Finite,
  outcome: SteeringAdmissionOutcome,
})
export type SteeringAdmission = typeof SteeringAdmission.Type

export interface QueuedSteeringAdmissionPreparation {
  readonly admission: SteeringAdmission
  readonly queue: import("./turn-repository-queue").QueueItemChange
  readonly queueChanged: boolean
}
