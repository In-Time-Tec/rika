import { Schema } from "effect"
import type { Event } from "./execution-event"
import type { ExecutionExtensionPin } from "./execution-workflow"
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

export type EventScope = "execution" | "tree"
export type SessionPurpose = { readonly _tag: "Conversation" }

export interface StartInput {
  readonly threadId: string
  readonly turnId: string
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly extensionPin?: ExecutionExtensionPin
  readonly executionRoute: ExecutionRouteSnapshot
  readonly reasoningEffort?: string
  readonly fastMode?: boolean
  readonly eventScope?: EventScope
  readonly sessionPurpose?: SessionPurpose
  readonly onEvent?: (event: Event) => void
}
