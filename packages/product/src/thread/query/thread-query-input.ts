import type * as ThreadRelationship from "../model/thread-relationship"
import type * as TranscriptPage from "../model/transcript-page"
import type * as TurnQueueState from "../queue/turn-queue-state"

export interface FindInput {
  readonly query: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

export interface LegacyReadInput {
  readonly threadId: string
  readonly includeArchived?: boolean
  readonly maxTurns?: number
  readonly maxChars?: number
}

export type Selector =
  | { readonly _tag: "overview" }
  | { readonly _tag: "recent"; readonly limit?: number; readonly before?: TurnQueueState.PageCursor }
  | {
      readonly _tag: "relevant"
      readonly query: string
      readonly limit?: number
      readonly before?: TranscriptPage.PageCursor
    }
  | {
      readonly _tag: "subtree"
      readonly childExecutionId: string
      readonly before?: TranscriptPage.PageCursor
      readonly offset?: number
    }
  | { readonly _tag: "related"; readonly before?: ThreadRelationship.RelationshipCursor }

export interface ReadInput {
  readonly threadId: string
  readonly includeArchived?: boolean
  readonly selector: Selector
}
