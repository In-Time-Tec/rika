import { Schema } from "effect"
import type { ExecutionRouteSnapshot } from "./execution-route-snapshot"

export const PromptPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, pasted: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mediaType: Schema.String,
    data: Schema.String,
    filename: Schema.optionalKey(Schema.String),
  }),
])
export type PromptPart = typeof PromptPart.Type

export interface StartInput {
  readonly threadId: string
  readonly turnId: string
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRouteSnapshot
}
