import type * as TranscriptPage from "../model/transcript-page"
import type * as TurnQueueState from "../repository/turn-repository-pagination"

export interface FindInput {
  readonly query: string
  readonly includeArchived?: boolean
  readonly limit?: number
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

export interface ReadInput {
  readonly threadId: string
  readonly includeArchived?: boolean
  readonly selector: Selector
}
