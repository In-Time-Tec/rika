import { Context, Effect, Schema } from "effect"
import * as Transcript from "@rika/transcript/transcript-unit"
import { Thread, ThreadId, ThreadLineage } from "@rika/product/thread-record"
import { Turn } from "@rika/product/turn-record"

export const schemaVersion = 2 as const
export const defaultPageSize = 50
export const maximumPageSize = 200
export const maximumSnippetLength = 240
export const maximumSnippets = 8

export const MatchSource = Schema.Literals([
  "title",
  "label",
  "humanPrompt",
  "agentPrompt",
  "rootAssistant",
  "childAssistant",
  "file",
])
export type MatchSource = typeof MatchSource.Type

export const OmissionReason = Schema.Literals(["snippetLimit", "snippetLength"])
export type OmissionReason = typeof OmissionReason.Type

export const Cursor = Schema.Struct({ updatedAt: Schema.Finite, threadId: ThreadId })
export type Cursor = typeof Cursor.Type

export const Snippet = Schema.Struct({ source: MatchSource, text: Schema.String })
export type Snippet = typeof Snippet.Type

export const Result = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  threadId: ThreadId,
  title: Schema.String,
  workspace: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
  matchedBy: Schema.Array(MatchSource),
  snippets: Schema.Array(Snippet),
  omissionReasons: Schema.Array(OmissionReason),
})
export type Result = typeof Result.Type

export interface SearchInput {
  readonly workspace: string
  readonly query: string
  readonly includeArchived?: boolean
  readonly label?: string
  readonly after?: number
  readonly before?: number
  readonly cursor?: Cursor
  readonly limit?: number
}

export interface SearchPage {
  readonly schemaVersion: 2
  readonly results: ReadonlyArray<Result>
  readonly nextCursor: Cursor | undefined
}

export interface RebuildInput {
  readonly thread: Thread
  readonly turns: ReadonlyArray<Turn>
  readonly units: ReadonlyArray<Transcript.Unit>
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadSearchRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly search: (input: SearchInput) => Effect.Effect<SearchPage, RepositoryError>
  readonly rebuildThread: (input: RebuildInput) => Effect.Effect<void, RepositoryError>
  readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/thread-search-repository/Service") {}

interface Document {
  readonly thread: Thread
  readonly title: string
  readonly labels: string
  readonly humanPrompts: string
  readonly agentPrompts: string
  readonly rootAssistant: string
  readonly childAssistant: string
  readonly files: string
}
