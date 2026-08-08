import { Schema } from "effect"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { PromptPart } from "@rika/product/execution-request"
import { TurnAuthor, TurnLineage } from "@rika/product/thread-relationship"
import { ExecutionLink, StartTurn } from "@rika/product/execution-gateway"

export const turnRowJson = {
  promptParts: Schema.fromJsonString(Schema.Array(PromptPart)),
  executionRoute: Schema.fromJsonString(ExecutionRouteSnapshot),
  executionLink: Schema.fromJsonString(ExecutionLink),
  startTurn: Schema.fromJsonString(StartTurn),
  author: Schema.fromJsonString(TurnAuthor),
  lineage: Schema.fromJsonString(TurnLineage),
} as const
