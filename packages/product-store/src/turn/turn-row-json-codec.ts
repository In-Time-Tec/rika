import { Schema } from "effect"
import { ExecutionExtensionPin } from "@rika/product/execution-workflow"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { PromptPart } from "@rika/product/execution-request"
import { TurnAuthor, TurnLineage } from "@rika/product/thread-relationship"

export const turnRowJson = {
  extensionPin: Schema.fromJsonString(ExecutionExtensionPin),
  promptParts: Schema.fromJsonString(Schema.Array(PromptPart)),
  executionRoute: Schema.fromJsonString(ExecutionRouteSnapshot),
  author: Schema.fromJsonString(TurnAuthor),
  lineage: Schema.fromJsonString(TurnLineage),
} as const
