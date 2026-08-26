import { Effect, Predicate, Schema } from "effect"
import { Prompt, Session, SessionHistory, ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { operation } from "../envelope"

export const name = "context"

export class ContextUnavailable extends Schema.TaggedError<ContextUnavailable>()("ContextUnavailable", {
  message: Schema.String,
}) {}

const Empty = Schema.Struct({})

const Entry = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  kind: Schema.String,
  text: Schema.String,
})

const Page = Schema.Struct({
  entries: Schema.Array(Entry),
  hasBefore: Schema.Boolean,
  hasAfter: Schema.Boolean,
  firstEntryId: Schema.optionalKey(Schema.String),
  lastEntryId: Schema.optionalKey(Schema.String),
  unknownCursors: Schema.optionalKey(Schema.Array(Schema.String)),
})

const Found = Schema.Struct({ entries: Schema.Array(Entry), hasMore: Schema.Boolean })

const Checkpoint = Schema.Struct({ id: Schema.String, summary: Schema.optionalKey(Schema.String) })

const Current = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
  runId: Schema.optionalKey(Schema.String),
  epoch: Schema.optionalKey(Schema.String),
  workspace: Schema.String,
  trustMode: Schema.String,
})

interface CurrentValue {
  threadId: string
  turnId?: string
  runId?: string
  epoch?: string
  workspace: string
  trustMode: string
}

interface PageValue {
  entries: Array<typeof Entry.Type>
  hasBefore: boolean
  hasAfter: boolean
  firstEntryId?: string
  lastEntryId?: string
  unknownCursors?: ReadonlyArray<string>
}

interface HistoryPageInput {
  limit: number
  before?: string
  after?: string
}

interface CheckpointValue {
  id: string
  summary?: string
}

const PageInput = Schema.Struct({
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
})

const SearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty()),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
})

const textOfMessage = (message: Prompt.Message): string => {
  const content = message.content
  return Predicate.isString(content)
    ? content
    : content
        .flatMap((part) => {
          if (part.type === "text" || part.type === "reasoning") return [part.text]
          if (part.type === "tool-call") return [`${part.name}(${JSON.stringify(part.params)})`]
          if (part.type === "tool-result") return [JSON.stringify(part.result)]
          return []
        })
        .join("\n")
}

const textOf = (entry: Session.Entry): string => {
  if (entry._tag === "Message" || entry._tag === "Steering") return textOfMessage(entry.message)
  if (entry._tag === "ToolCall") return JSON.stringify(entry.part.params)
  if (entry._tag === "ToolResult") return JSON.stringify(entry.part.result)
  if (entry._tag === "Memory") return entry.items.join("\n")
  if (entry._tag === "Skill") return entry.name
  if (entry._tag === "Handoff") return entry.projectedHistory.content.map(textOfMessage).filter(Boolean).join("\n")
  if (entry._tag === "BranchSummary") return entry.summary
  if (entry._tag === "ModelResponse") {
    return entry.content
      .flatMap((part) => {
        if (part.type === "text" || part.type === "reasoning") return [part.text]
        if (part.type === "tool-call") return [`${part.name}(${JSON.stringify(part.params)})`]
        if (part.type === "tool-result") return [JSON.stringify(part.result)]
        return []
      })
      .join("\n")
  }
  return entry._tag === "Compaction" ? (entry.summary ?? "") : ""
}

const projected = (entry: Session.Entry) => ({
  id: entry.id,
  parentId: entry.parentId,
  kind: entry._tag,
  text: textOf(entry),
})

const unavailable = (cause: { readonly message: string }) => ContextUnavailable.make({ message: cause.message })

/**
 * Every operation reads the exact entry path and never appends. `SessionStore.append` is deliberately
 * unreachable from this module: the kernel observes canonical history, it never authors it.
 */
const path = Effect.flatMap(Session.SessionStore, (store) => store.path()).pipe(Effect.mapError(unavailable))

export const make = (options: {
  readonly workspace: string
  readonly trustMode: string
}): HostBindingRegistry.Module<Session.SessionStore | ToolContext.ToolContext> => ({
  name,
  operations: [
    operation({
      name: "current",
      input: Empty,
      output: Current,
      failure: ContextUnavailable,
      handle: () =>
        Effect.map(ToolContext.ToolContext, (context) => {
          const current: CurrentValue = {
            threadId: context.sessionId,
            workspace: options.workspace,
            trustMode: options.trustMode,
          }
          if (context.toolCallId !== undefined) current.turnId = context.toolCallId
          if (context.runId !== undefined) current.runId = context.runId
          if (context.operationKey !== undefined) current.epoch = context.operationKey
          return current
        }),
    }),
    operation({
      name: "historyPage",
      input: PageInput,
      output: Page,
      failure: ContextUnavailable,
      handle: (input) =>
        Effect.map(path, (entries) => {
          const pageInput: HistoryPageInput = { limit: input.limit }
          if (input.before !== undefined) pageInput.before = input.before
          if (input.after !== undefined) pageInput.after = input.after
          const page = SessionHistory.pageHistory(entries, pageInput)
          const result: PageValue = {
            entries: page.entries.map(projected),
            hasBefore: page.hasBefore,
            hasAfter: page.hasAfter,
          }
          if (page.firstEntryId !== undefined) result.firstEntryId = page.firstEntryId
          if (page.lastEntryId !== undefined) result.lastEntryId = page.lastEntryId
          if (page.unknownCursors !== undefined) result.unknownCursors = page.unknownCursors
          return result
        }),
    }),
    operation({
      name: "searchHistory",
      input: SearchInput,
      output: Found,
      failure: ContextUnavailable,
      handle: (input) =>
        Effect.map(path, (entries) => {
          const needle = input.query.toLowerCase()
          const matched = entries.map(projected).filter((entry) => entry.text.toLowerCase().includes(needle))
          return { entries: matched.slice(0, input.limit), hasMore: matched.length > input.limit }
        }),
    }),
    operation({
      name: "compactions",
      input: Empty,
      output: Schema.Array(Checkpoint),
      failure: ContextUnavailable,
      handle: () =>
        Effect.map(path, (entries) =>
          SessionHistory.compactionCheckpoints(entries).map((checkpoint) => {
            const result: CheckpointValue = { id: checkpoint.id }
            if (checkpoint.summary !== undefined) result.summary = checkpoint.summary
            return result
          }),
        ),
    }),
  ],
})
