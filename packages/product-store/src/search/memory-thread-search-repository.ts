import { Service } from "@rika/product/thread-search-repository"
export { Service }
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Layer, Ref, Schema } from "effect"
import { Thread, ThreadId } from "@rika/product/thread-record"
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

const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const normalize = (value: string) => value.toLocaleLowerCase()
const boundedLimit = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
const sourceOrder: ReadonlyArray<readonly [MatchSource, keyof Omit<Document, "thread">]> = [
  ["title", "title"],
  ["label", "labels"],
  ["humanPrompt", "humanPrompts"],
  ["agentPrompt", "agentPrompts"],
  ["rootAssistant", "rootAssistant"],
  ["childAssistant", "childAssistant"],
  ["file", "files"],
]

interface ParsedQuery {
  readonly terms: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
}

const parseQuery = (query: string): ParsedQuery => {
  const terms: Array<string> = []
  const files: Array<string> = []
  const token = /"([^"]+)"|(\S+)/g
  for (const match of query.matchAll(token)) {
    const value = match[1] ?? match[2] ?? ""
    const separator = value.indexOf(":")
    if (separator >= 0) {
      const field = value.slice(0, separator).toLowerCase()
      const content = value.slice(separator + 1)
      if (field !== "file") throw error(`Unsupported search field '${field}'. Supported field: file`)
      if (content.length > 0) files.push(content)
    } else if (value.length > 0) terms.push(value)
  }
  return { terms, files }
}
const includesAll = (text: string, values: ReadonlyArray<string>) => {
  const candidate = normalize(text)
  return values.every((value) => candidate.includes(normalize(value)))
}
const makeDocument = (input: RebuildInput): Document => {
  const prompts = { human: [] as Array<string>, agent: [] as Array<string> }
  for (const turn of input.turns) prompts[turn.author._tag === "Human" ? "human" : "agent"].push(turn.prompt)
  const rootAssistant: Array<string> = []
  const childAssistant = new Map<string, string>()
  const files = new Set<string>()
  for (const unit of input.units) {
    if (unit.content._tag === "Entry" && unit.content.role === "assistant") {
      if (unit.parentId === undefined) rootAssistant.push(unit.content.text)
      else childAssistant.set(unit.parentId, unit.content.text)
    }
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") continue
    if (unit.content.block.status !== "complete") continue
    for (const file of unit.content.block.files)
      if (file.status === "complete" && !file.preview) {
        files.add(file.path)
        if (file.previousPath !== undefined) files.add(file.previousPath)
      }
  }
  return {
    thread: structuredClone(input.thread),
    title: input.thread.title,
    labels: input.thread.labels.join("\n"),
    humanPrompts: prompts.human.join("\n"),
    agentPrompts: prompts.agent.join("\n"),
    rootAssistant: rootAssistant.at(-1) ?? "",
    childAssistant: [...childAssistant.values()].join("\n"),
    files: [...files].toSorted().join("\n"),
  }
}
const resultFor = (document: Document, parsed: ParsedQuery): Result | undefined => {
  const searchable = sourceOrder.map(([, key]) => document[key]).join("\n")
  if (!includesAll(searchable, parsed.terms) || !includesAll(document.files, parsed.files)) return undefined
  const matchedBy: Array<MatchSource> = []
  const snippets: Array<Snippet> = []
  let shortened = false
  for (const [source, key] of sourceOrder) {
    const text = document[key]
    const relevant =
      parsed.terms.some((term) => includesAll(text, [term])) ||
      (source === "file" && parsed.files.some((path) => includesAll(text, [path])))
    if (!relevant) continue
    matchedBy.push(source)
    if (snippets.length >= maximumSnippets) continue
    const trimmed = text.trim()
    shortened ||= trimmed.length > maximumSnippetLength
    snippets.push({ source, text: trimmed.slice(0, maximumSnippetLength) })
  }
  const omitted = matchedBy.length > snippets.length
  return {
    schemaVersion,
    threadId: document.thread.id,
    title: document.thread.title,
    workspace: document.thread.workspace,
    createdAt: document.thread.createdAt,
    updatedAt: document.thread.updatedAt,
    archived: document.thread.archived,
    matchedBy,
    snippets,
    omissionReasons: [...(omitted ? ["snippetLimit" as const] : []), ...(shortened ? ["snippetLength" as const] : [])],
  }
}
const selected = (documents: ReadonlyArray<Document>, input: SearchInput, parsed: ParsedQuery): SearchPage => {
  const limit = boundedLimit(input.limit)
  const results = documents
    .filter((document) => document.thread.workspace === input.workspace)
    .filter((document) => input.includeArchived === true || !document.thread.archived)
    .filter((document) => input.label === undefined || document.thread.labels.includes(input.label))
    .filter((document) => input.after === undefined || document.thread.updatedAt >= input.after)
    .filter((document) => input.before === undefined || document.thread.updatedAt <= input.before)
    .filter(
      (document) =>
        input.cursor === undefined ||
        document.thread.updatedAt < input.cursor.updatedAt ||
        (document.thread.updatedAt === input.cursor.updatedAt && document.thread.id > input.cursor.threadId),
    )
    .flatMap((document) => {
      const result = resultFor(document, parsed)
      return result === undefined ? [] : [result]
    })
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId))
  const page = results.slice(0, limit)
  const last = page.at(-1)
  return {
    schemaVersion,
    results: page,
    nextCursor:
      results.length > limit && last !== undefined ? { updatedAt: last.updatedAt, threadId: last.threadId } : undefined,
  }
}
export const makeMemory = Effect.gen(function* () {
  const state = yield* Ref.make(new Map<ThreadId, Document>())
  return Service.of({
    search: Effect.fn("ThreadSearchRepository.search")(function* (input) {
      const parsed = yield* Effect.try({ try: () => parseQuery(input.query), catch: error })
      return selected([...(yield* Ref.get(state)).values()], input, parsed)
    }),
    rebuildThread: Effect.fn("ThreadSearchRepository.rebuildThread")(function* (input) {
      yield* Ref.update(state, (documents) => new Map(documents).set(input.thread.id, makeDocument(input)))
    }),
    removeThread: Effect.fn("ThreadSearchRepository.removeThread")(function* (threadId) {
      yield* Ref.update(state, (documents) => {
        const next = new Map(documents)
        next.delete(threadId)
        return next
      })
    }),
  })
})
export const memoryLayer = Layer.effect(Service, makeMemory)
