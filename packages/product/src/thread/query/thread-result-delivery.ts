import type { Selector } from "./thread-query-input"
import type { PageCursor as TranscriptCursor } from "../model/transcript-page"
import type { PageCursor as TurnCursor } from "../repository/turn-repository-pagination"

export interface Result {
  readonly text: string
  readonly truncated: boolean
}

export interface Omission {
  readonly reason: "olderTurns" | "responseBudget" | "unavailableChild"
  readonly continuation: Selector
}

export interface ReadItem {
  readonly turnId: string
  readonly author: "human" | "agent"
  readonly createdAt: string
  readonly status: string
  readonly messages: ReadonlyArray<Message>
}

export interface Message {
  readonly role: "user" | "assistant" | "notice" | "child"
  readonly text: string
  readonly childExecutionId?: string
  readonly children?: ReadonlyArray<Message>
}

export interface ReadSuccess {
  readonly schemaVersion: 2
  readonly threadId: string
  readonly title: string
  readonly selector: Selector
  readonly items: ReadonlyArray<ReadItem>
  readonly nextCursor?: TurnCursor | TranscriptCursor
  readonly omissions: ReadonlyArray<Omission>
  readonly truncated: boolean
}

export interface FindSuccess {
  readonly schemaVersion: 2
  readonly threads: ReadonlyArray<{
    readonly threadId: string
    readonly state: "idle" | "queued" | "running" | "error"
    readonly archived: boolean
    readonly title: string
    readonly updatedAt: string
    readonly summary: string
    readonly truncated: boolean
  }>
  readonly truncated: boolean
}
