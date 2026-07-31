import type { Event } from "./execution-event"
import type { ExecutionExtensionPin } from "./execution-workflow"
import type { ExecutionRouteSnapshot } from "./execution-route-snapshot"

export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string; readonly filename?: string }

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
