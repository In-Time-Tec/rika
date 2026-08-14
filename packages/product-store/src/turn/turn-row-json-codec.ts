import { Schema } from "effect"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { PromptPart } from "@rika/product/execution-request"
import { TurnAuthor, TurnLineage } from "@rika/product/thread-relationship"
import { ExecutionLink, StartTurn } from "@rika/product/execution-gateway"
import { AgentExecutionTurn } from "@rika/product/turn-record"
import { SteeringAdmission } from "@rika/product/turn-repository-steering"

export const turnRowJson = {
  promptParts: Schema.fromJsonString(Schema.Array(PromptPart)),
  executionRoute: Schema.fromJsonString(ExecutionRouteSnapshot),
  executionLink: Schema.fromJsonString(ExecutionLink),
  startTurn: Schema.fromJsonString(StartTurn),
  agentTurn: Schema.fromJsonString(AgentExecutionTurn),
  steeringAdmission: Schema.fromJsonString(SteeringAdmission),
  author: Schema.fromJsonString(TurnAuthor),
  lineage: Schema.fromJsonString(TurnLineage),
} as const
