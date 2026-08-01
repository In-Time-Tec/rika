import { Context, Effect, Schema } from "effect"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Thread, ThreadId } from "@rika/product/thread-record"
import { Turn } from "@rika/product/turn-record"

const MatchSource = Schema.Literals([
  "title",
  "label",
  "humanPrompt",
  "agentPrompt",
  "rootAssistant",
  "childAssistant",
  "file",
])
type MatchSource = typeof MatchSource.Type

const OmissionReason = Schema.Literals(["snippetLimit", "snippetLength"])
type OmissionReason = typeof OmissionReason.Type

const Cursor = Schema.Struct({ updatedAt: Schema.Finite, threadId: ThreadId })
type Cursor = typeof Cursor.Type

const Snippet = Schema.Struct({ source: MatchSource, text: Schema.String })
type Snippet = typeof Snippet.Type

const Result = Schema.Struct({
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
type Result = typeof Result.Type

interface SearchInput {
  readonly workspace: string
  readonly query: string
  readonly includeArchived?: boolean
  readonly label?: string
  readonly after?: number
  readonly before?: number
  readonly cursor?: Cursor
  readonly limit?: number
}

interface SearchPage {
  readonly schemaVersion: 2
  readonly results: ReadonlyArray<Result>
  readonly nextCursor: Cursor | undefined
}

interface RebuildInput {
  readonly thread: Thread
  readonly turns: ReadonlyArray<Turn>
  readonly units: ReadonlyArray<TranscriptUnit.Unit>
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadSearchRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly search: (input: SearchInput) => Effect.Effect<SearchPage, RepositoryError>
  readonly rebuildThread: (input: RebuildInput) => Effect.Effect<void, RepositoryError>
  readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/thread-search-repository/Service",
) {}
