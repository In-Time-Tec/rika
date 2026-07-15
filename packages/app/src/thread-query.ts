import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import { Context, Effect, Layer, Schema } from "effect"

export interface FindInput {
  readonly query: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

export interface ReadInput {
  readonly threadId: string
  readonly includeArchived?: boolean
  readonly maxTurns?: number
  readonly maxChars?: number
}

export interface Result {
  readonly text: string
  readonly truncated: boolean
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<Result, QueryError>
  readonly read: (input: ReadInput) => Effect.Effect<Result, QueryError | ThreadNotFoundError | ArchivedThreadError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/thread-query/Service") {}

export class QueryError extends Schema.TaggedErrorClass<QueryError>()("ThreadQueryError", {
  message: Schema.String,
}) {}

export class ThreadNotFoundError extends Schema.TaggedErrorClass<ThreadNotFoundError>()("ThreadNotFoundError", {
  threadId: Schema.String,
}) {}

export class ArchivedThreadError extends Schema.TaggedErrorClass<ArchivedThreadError>()("ArchivedThreadError", {
  threadId: Schema.String,
}) {}

type Term = { readonly key: string; readonly value: string }
const supported = new Set(["workspace", "repo", "ref", "author", "label", "file", "after", "before"])
const parse = (query: string) => {
  const terms: Array<Term> = []
  const text: Array<string> = []
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf(":")
    const key = separator < 0 ? "" : token.slice(0, separator).toLowerCase()
    const value = separator < 0 ? token : token.slice(separator + 1)
    if (supported.has(key) && value.length > 0) terms.push({ key, value })
    else text.push(token)
  }
  return { terms, text: text.join(" ") }
}

const date = (value: string) => {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const matches = (
  thread: {
    readonly workspace: string
    readonly title: string
    readonly labels: ReadonlyArray<string>
    readonly createdAt: number
  },
  terms: ReadonlyArray<Term>,
) =>
  terms.every(({ key, value }) => {
    const normalized = value.toLowerCase()
    if (key === "workspace" || key === "repo") return thread.workspace.toLowerCase().includes(normalized)
    if (key === "label") return thread.labels.some((label) => label.toLowerCase() === normalized)
    if (key === "after") return (date(value) ?? Number.POSITIVE_INFINITY) <= thread.createdAt
    if (key === "before") return thread.createdAt < (date(value) ?? Number.NEGATIVE_INFINITY)
    return [thread.title, thread.workspace, ...thread.labels].some((field) =>
      field.toLowerCase().includes(`${key}:${normalized}`),
    )
  })

const bound = (text: string, maximum: number): Result => ({
  text: text.slice(0, maximum),
  truncated: text.length > maximum,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    return Service.of({
      find: Effect.fn("ThreadQuery.find")(function* (input) {
        const parsed = parse(input.query)
        const limit = Math.min(Math.max(1, input.limit ?? 20), 100)
        const found = yield* threads
          .list({
            includeArchived: input.includeArchived === true,
            limit: 100,
            ...(parsed.text.length > 0 ? { query: parsed.text } : {}),
          })
          .pipe(Effect.mapError((error) => QueryError.make({ message: error.message })))
        const selected = found.filter((thread) => matches(thread, parsed.terms)).slice(0, limit)
        return bound(
          selected
            .map((thread) =>
              JSON.stringify({
                id: thread.id,
                title: thread.title,
                workspace: thread.workspace,
                labels: thread.labels,
                pinned: thread.pinned,
                archived: thread.archived,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
              }),
            )
            .join("\n"),
          20_000,
        )
      }),
      read: Effect.fn("ThreadQuery.read")(function* (input) {
        const threadId = Thread.ThreadId.make(input.threadId)
        const thread = yield* threads
          .get(threadId)
          .pipe(Effect.mapError((error) => QueryError.make({ message: error.message })))
        if (thread === undefined) return yield* ThreadNotFoundError.make({ threadId: input.threadId })
        if (thread.archived && input.includeArchived !== true)
          return yield* ArchivedThreadError.make({ threadId: input.threadId })
        const allTurns = yield* turns
          .list(threadId)
          .pipe(Effect.mapError((error) => QueryError.make({ message: error.message })))
        const selected = allTurns.slice(0, Math.min(Math.max(1, input.maxTurns ?? 50), 200))
        const sections = selected.map((turn) =>
          [`## Turn ${turn.id} (${turn.status})`, `User: ${turn.prompt}`].join("\n"),
        )
        const text = [`# ${thread.title}`, `Thread: ${thread.id}`, `Workspace: ${thread.workspace}`, ...sections].join(
          "\n\n",
        )
        return bound(text, Math.min(Math.max(1, input.maxChars ?? 40_000), 40_000))
      }),
    })
  }),
)

export const testLayer = (service: Interface) => Layer.succeed(Service, Service.of(service))
