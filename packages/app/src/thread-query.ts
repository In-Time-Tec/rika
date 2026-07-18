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
const date = (value: string) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (parts === null) return undefined
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return undefined
  return Date.parse(value)
}

const parse = Effect.fn("ThreadQuery.parse")(function* (query: string) {
  const terms: Array<Term> = []
  const text: Array<string> = []
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf(":")
    if (separator < 0) {
      text.push(token)
      continue
    }
    const key = token.slice(0, separator).toLowerCase()
    const value = token.slice(separator + 1)
    if (!supported.has(key) || value.length === 0)
      return yield* QueryError.make({ message: `Invalid Thread query filter: ${token}` })
    if ((key === "after" || key === "before") && date(value) === undefined)
      return yield* QueryError.make({ message: `Invalid Thread query date: ${value}` })
    terms.push({ key, value })
  }
  return { terms, text: text.join(" ") }
})

const boundedInteger = Effect.fn("ThreadQuery.boundedInteger")(function* (
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum)
    return yield* QueryError.make({ message: `${name} must be an integer from 1 to ${maximum}` })
  return resolved
})

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

const bound = (text: string, maximum: number, truncated = false): Result => ({
  text: text.slice(0, maximum),
  truncated: truncated || text.length > maximum,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    return Service.of({
      find: Effect.fn("ThreadQuery.find")(function* (input) {
        const parsed = yield* parse(input.query)
        const limit = yield* boundedInteger("limit", input.limit, 20, 100)
        const found = yield* threads
          .list({
            includeArchived: input.includeArchived === true,
            limit: 100,
            ...(parsed.text.length > 0 ? { query: parsed.text } : {}),
          })
          .pipe(Effect.mapError((error) => QueryError.make({ message: error.message })))
        const matched = found.filter((thread) => matches(thread, parsed.terms))
        const selected = matched.slice(0, limit)
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
          matched.length > limit || matched.length === 100,
        )
      }),
      read: Effect.fn("ThreadQuery.read")(function* (input) {
        if (input.threadId.trim().length === 0 || input.threadId.trim() !== input.threadId)
          return yield* QueryError.make({ message: "threadId must be a non-empty identifier" })
        const maxTurns = yield* boundedInteger("maxTurns", input.maxTurns, 50, 200)
        const maxChars = yield* boundedInteger("maxChars", input.maxChars, 40_000, 40_000)
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
        const selected = allTurns.slice(0, maxTurns)
        const sections = selected.map((turn) =>
          [`## Turn ${turn.id} (${turn.status})`, `User: ${turn.prompt}`].join("\n"),
        )
        const text = [`# ${thread.title}`, `Thread: ${thread.id}`, `Workspace: ${thread.workspace}`, ...sections].join(
          "\n\n",
        )
        return bound(text, maxChars, allTurns.length > maxTurns)
      }),
    })
  }),
)

export const testLayer = (service: Interface) => Layer.succeed(Service, Service.of(service))
