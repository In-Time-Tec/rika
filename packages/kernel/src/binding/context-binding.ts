import { Effect, Schema } from "effect"
import { Session, SessionHistory, ToolContext } from "@batonfx/core"
import type { HostBindingRegistry } from "@batonfx/repl"
import { operation } from "./nested-operation-envelope"

export const name = "context"

export class ContextUnavailable extends Schema.TaggedErrorClass<ContextUnavailable>()("ContextUnavailable", {
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

const PageInput = Schema.Struct({
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
})

const SearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty()),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
})

const textOf = (entry: Session.Entry): string => {
  if (entry._tag === "Message" || entry._tag === "Steering") {
    const content = entry.message.content
    return typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  }
  if (entry._tag === "ToolCall") return JSON.stringify(entry.part.params)
  if (entry._tag === "ToolResult") return JSON.stringify(entry.part.result)
  if (entry._tag === "Memory") return entry.items.join("\n")
  if (entry._tag === "Skill") return entry.name
  if (entry._tag === "Handoff") return entry.summary
  if (entry._tag === "BranchSummary") return entry.summary
  return entry.summary ?? ""
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
        Effect.map(ToolContext.ToolContext, (context) => ({
          threadId: context.sessionId,
          ...(context.toolCallId === undefined ? {} : { turnId: context.toolCallId }),
          ...(context.runId === undefined ? {} : { runId: context.runId }),
          ...(context.operationKey === undefined ? {} : { epoch: context.operationKey }),
          workspace: options.workspace,
          trustMode: options.trustMode,
        })),
    }),
    operation({
      name: "historyPage",
      input: PageInput,
      output: Page,
      failure: ContextUnavailable,
      handle: (input) =>
        Effect.map(path, (entries) => {
          const page = SessionHistory.pageHistory(entries, {
            limit: input.limit,
            ...(input.before === undefined ? {} : { before: input.before }),
            ...(input.after === undefined ? {} : { after: input.after }),
          })
          return {
            entries: page.entries.map(projected),
            hasBefore: page.hasBefore,
            hasAfter: page.hasAfter,
            ...(page.firstEntryId === undefined ? {} : { firstEntryId: page.firstEntryId }),
            ...(page.lastEntryId === undefined ? {} : { lastEntryId: page.lastEntryId }),
          }
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
          SessionHistory.compactionCheckpoints(entries).map((checkpoint) => ({
            id: checkpoint.id,
            ...(checkpoint.summary === undefined ? {} : { summary: checkpoint.summary }),
          })),
        ),
    }),
  ],
})
