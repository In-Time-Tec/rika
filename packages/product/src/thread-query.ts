import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product/thread-search-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import * as ThreadState from "@rika/product/thread-state"

export const schemaVersion = 2 as const
export const transcriptBudget = 36_000

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
export interface Result {
  readonly text: string
  readonly truncated: boolean
}
export type Selector =
  | { readonly _tag: "overview" }
  | { readonly _tag: "recent"; readonly limit?: number; readonly before?: TurnRepository.PageCursor }
  | {
      readonly _tag: "relevant"
      readonly query: string
      readonly limit?: number
      readonly before?: TranscriptRepository.PageCursor
    }
  | {
      readonly _tag: "subtree"
      readonly childExecutionId: string
      readonly before?: TranscriptRepository.PageCursor
      readonly offset?: number
    }
  | {
      readonly _tag: "related"
      readonly before?: ThreadInteractionRepository.RelationshipCursor
    }
export interface ReadInput {
  readonly threadId: string
  readonly includeArchived?: boolean
  readonly selector: Selector
}
export interface Omission {
  readonly reason: "olderTurns" | "responseBudget" | "unavailableChild" | "relationshipsUnavailable"
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
export interface RelatedThread {
  readonly kind: "created" | "message" | "reply" | "fork"
  readonly direction: "incoming" | "outgoing"
  readonly threadId: string
  readonly turnId: string
  readonly title: string
  readonly archived: boolean
  readonly available: boolean
  readonly createdAt: string
}
export interface ReadSuccess {
  readonly schemaVersion: 2
  readonly threadId: string
  readonly title: string
  readonly selector: Selector
  readonly items: ReadonlyArray<ReadItem>
  readonly relatedThreads: ReadonlyArray<RelatedThread>
  readonly nextCursor?: TurnRepository.PageCursor | TranscriptRepository.PageCursor
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
export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<FindSuccess, QueryError>
  readonly search: (input: FindInput) => Effect.Effect<Result, QueryError>
  readonly readStructured: (
    input: ReadInput,
  ) => Effect.Effect<ReadSuccess, QueryError | ThreadNotFoundError | ArchivedThreadError>
  readonly read: (
    input: LegacyReadInput,
  ) => Effect.Effect<Result, QueryError | ThreadNotFoundError | ArchivedThreadError>
}
export class Service extends Context.Service<Service, Interface>()("@rika/product/thread-query/Service") {}
export class Factory extends Context.Service<
  Factory,
  { readonly forWorkspace: (workspace: string) => Effect.Effect<Interface> }
>()("@rika/product/thread-query/Factory") {}
export class QueryError extends Schema.TaggedErrorClass<QueryError>()("ThreadQueryError", { message: Schema.String }) {}
export class ThreadNotFoundError extends Schema.TaggedErrorClass<ThreadNotFoundError>()("ThreadNotFoundError", {
  threadId: Schema.String,
}) {}
export class ArchivedThreadError extends Schema.TaggedErrorClass<ArchivedThreadError>()("ArchivedThreadError", {
  threadId: Schema.String,
}) {}

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const iso = (timestamp: number) => DateTime.formatIso(DateTime.makeUnsafe(timestamp))

const bounded = (name: string, value: number | undefined, fallback: number, maximum: number) =>
  Effect.gen(function* () {
    const result = value ?? fallback
    if (!Number.isInteger(result) || result < 1 || result > maximum)
      return yield* QueryError.make({ message: `${name} must be an integer from 1 to ${maximum}` })
    return result
  })
const safeText = (text: string, limit: number) => [...text].slice(0, limit).join("")
const threadState = (
  threadTurns: ReadonlyArray<TurnRepository.PageResult["turns"][number]>,
): FindSuccess["threads"][number]["state"] => ThreadState.threadState(threadTurns.map((turn) => turn.status))

interface ChildLink {
  readonly executionId: string
  readonly parentId: string
  readonly text: string
}

const childLink = (unit: TranscriptUnit.Unit): ChildLink | undefined => {
  if (unit.content._tag !== "Block") return undefined
  const block = unit.content.block
  if (block._tag === "ChildAgent") return { executionId: block.id, parentId: block.id, text: block.summary }
  if (block._tag === "ToolCall" && block.childId !== undefined)
    return { executionId: block.childId, parentId: block.id, text: block.output ?? block.detail }
  return undefined
}

const message = (
  unit: TranscriptUnit.Unit,
  all: ReadonlyArray<TranscriptUnit.Unit>,
  textLimit = 12_000,
): Message | undefined => {
  if (unit.content._tag === "Entry") return { role: unit.content.role, text: safeText(unit.content.text, textLimit) }
  const link = childLink(unit)
  if (link === undefined) return undefined
  const children = all
    .filter((candidate) => candidate.parentId === link.parentId)
    .flatMap((candidate) => {
      const rendered = message(candidate, all, textLimit)
      return rendered === undefined ? [] : [rendered]
    })
  return {
    role: "child",
    text: safeText(link.text, textLimit),
    childExecutionId: link.executionId,
    ...(children.length === 0 ? {} : { children }),
  }
}
const item = (
  turn: TurnRepository.PageResult["turns"][number],
  units: ReadonlyArray<TranscriptUnit.Unit>,
): ReadItem => ({
  turnId: turn.id,
  author: turn.author._tag === "Human" ? "human" : "agent",
  createdAt: iso(turn.createdAt),
  status: turn.status,
  messages: units
    .filter((unit) => unit.parentId === undefined)
    .flatMap((unit) => {
      const value = message(unit, units)
      return value === undefined ? [] : [value]
    }),
})
const subtreeItem = (
  turn: TurnRepository.PageResult["turns"][number],
  root: TranscriptUnit.Unit,
  descendants: ReadonlyArray<TranscriptUnit.Unit>,
): ReadItem => {
  const rendered = message(root, [root, ...descendants], 8_000)
  return {
    turnId: turn.id,
    author: turn.author._tag === "Human" ? "human" : "agent",
    createdAt: iso(turn.createdAt),
    status: turn.status,
    messages: rendered === undefined ? [] : [rendered],
  }
}

const boundedSubtreeItem = (
  turn: TurnRepository.PageResult["turns"][number],
  root: TranscriptUnit.Unit,
  candidate: TranscriptUnit.Unit,
): ReadItem => {
  const renderedRoot = message(root, [root], 4_000)
  const renderedCandidate = message(candidate, [candidate], 4_000)
  return {
    turnId: turn.id,
    author: turn.author._tag === "Human" ? "human" : "agent",
    createdAt: iso(turn.createdAt),
    status: turn.status,
    messages:
      renderedRoot === undefined
        ? []
        : [
            renderedCandidate === undefined || renderedRoot.role !== "child"
              ? renderedRoot
              : { ...renderedRoot, children: [renderedCandidate] },
          ],
  }
}
const encodeBounded = (
  base: Omit<ReadSuccess, "items" | "omissions" | "truncated">,
  candidates: ReadonlyArray<ReadItem>,
  omissions: ReadonlyArray<Omission>,
  maximum = transcriptBudget,
): ReadSuccess => {
  const selected: Array<ReadItem> = []
  let budgetOmitted = false
  for (const candidate of candidates) {
    const trial: ReadSuccess = { ...base, items: [...selected, candidate], omissions, truncated: omissions.length > 0 }
    if (encodeJson(trial).length > maximum) {
      budgetOmitted = true
      break
    }
    selected.push(candidate)
  }
  const finalOmissions = budgetOmitted
    ? [...omissions, { reason: "responseBudget" as const, continuation: base.selector }]
    : omissions
  return { ...base, items: selected, omissions: finalOmissions, truncated: finalOmissions.length > 0 }
}
const mapError = (error: { readonly message: string }) => QueryError.make({ message: error.message })

export const makeForWorkspace = (workspace: string) =>
  Effect.gen(function* () {
    const threadRepository = yield* ThreadRepository.Service
    const searches = yield* ThreadSearchRepository.Service
    const interactions = yield* ThreadInteractionRepository.Service
    const turns = yield* TurnRepository.Service
    const transcripts = yield* TranscriptRepository.Service
    const rebuildWorkspaceSearch = Effect.fn("ThreadQuery.rebuildWorkspaceSearch")(function* () {
      const workspaceThreads = (yield* threadRepository.listAll).filter((thread) => thread.workspace === workspace)
      yield* Effect.forEach(
        workspaceThreads,
        (thread) =>
          Effect.gen(function* () {
            const threadTurns = yield* turns.list(thread.id)
            const units = yield* Effect.forEach(threadTurns, (turn) => transcripts.get(turn.id), {
              concurrency: 8,
            }).pipe(Effect.map((projections) => projections.flatMap((projection) => projection?.units ?? [])))
            yield* searches.rebuildThread({ thread, turns: threadTurns, units })
          }),
        { concurrency: 4, discard: true },
      )
    })
    const find = Effect.fn("ThreadQuery.find")(function* (input: FindInput) {
      if (input.query.trim().length === 0) return yield* QueryError.make({ message: "query must be non-empty" })
      const limit = yield* bounded("limit", input.limit, 10, 50)
      yield* rebuildWorkspaceSearch().pipe(Effect.mapError(mapError))
      const page = yield* searches
        .search({
          workspace,
          query: input.query,
          limit,
          ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
        })
        .pipe(Effect.mapError(mapError))
      const results = yield* Effect.forEach(
        page.results,
        (result) =>
          Effect.gen(function* () {
            const threadTurns = yield* turns.list(result.threadId).pipe(Effect.mapError(mapError))
            const summary = safeText(result.snippets.map((snippet) => snippet.text).join(" · ") || result.title, 128)
            return {
              threadId: result.threadId,
              state: threadState(threadTurns),
              archived: result.archived,
              title: safeText(result.title, 128),
              updatedAt: iso(result.updatedAt),
              summary,
              truncated:
                summary !== result.snippets.map((snippet) => snippet.text).join(" · ") ||
                result.omissionReasons.length > 0,
            }
          }),
        { concurrency: 8 },
      )
      return { schemaVersion, threads: results, truncated: page.nextCursor !== undefined }
    })
    const readStructured = Effect.fn("ThreadQuery.readStructured")(function* (input: ReadInput) {
      if (input.threadId.trim().length === 0 || input.threadId.trim() !== input.threadId)
        return yield* QueryError.make({ message: "threadId must be a non-empty identifier" })
      const threadId = Thread.ThreadId.make(input.threadId)
      const thread = yield* threadRepository.get(threadId).pipe(Effect.mapError(mapError))
      if (thread === undefined || thread.workspace !== workspace)
        return yield* ThreadNotFoundError.make({ threadId: input.threadId })
      if (thread.archived && input.includeArchived !== true)
        return yield* ArchivedThreadError.make({ threadId: input.threadId })
      const base = {
        schemaVersion,
        threadId: input.threadId,
        title: thread.title,
        selector: input.selector,
        relatedThreads: [],
      }
      if (input.selector._tag === "overview") return encodeBounded(base, [], [])
      if (input.selector._tag === "related") {
        const relationships = yield* interactions
          .listRelationships(threadId, 21, input.selector.before)
          .pipe(Effect.mapError(mapError))
        const page = relationships.slice(0, 20)
        const relatedThreads = yield* Effect.forEach(page, (relationship) =>
          Effect.gen(function* () {
            const outgoing = relationship.sourceThreadId === threadId
            const relatedThreadId = outgoing ? relationship.targetThreadId : relationship.sourceThreadId
            const relatedTurnId = outgoing ? relationship.targetTurnId : relationship.sourceTurnId
            const related = yield* threadRepository.get(relatedThreadId).pipe(Effect.mapError(mapError))
            const available = related !== undefined && related.workspace === workspace
            return {
              kind: relationship.kind,
              direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
              threadId: relatedThreadId,
              turnId: relatedTurnId,
              title: available ? related.title : "Unavailable Thread",
              archived: available ? related.archived : false,
              available,
              createdAt: iso(relationship.createdAt),
            }
          }),
        )
        const last = page.at(-1)
        const omissions: ReadonlyArray<Omission> =
          relationships.length > page.length && last !== undefined
            ? [
                {
                  reason: "relationshipsUnavailable",
                  continuation: {
                    _tag: "related",
                    before: { createdAt: last.createdAt, targetTurnId: last.targetTurnId },
                  },
                },
              ]
            : []
        return encodeBounded({ ...base, relatedThreads }, [], omissions)
      }
      if (input.selector._tag === "subtree") {
        const childExecutionId = input.selector.childExecutionId
        const page = yield* transcripts
          .page(threadId, { before: input.selector.before, limit: 200 })
          .pipe(Effect.mapError(mapError))
        const root = page.entries.find((entry) => childLink(entry.unit)?.executionId === childExecutionId)
        if (root === undefined) {
          const continuation =
            page.hasOlder && page.oldestCursor !== undefined
              ? { ...input.selector, before: page.oldestCursor }
              : input.selector
          return encodeBounded(base, [], [{ reason: page.hasOlder ? "olderTurns" : "unavailableChild", continuation }])
        }
        const projection = yield* transcripts.get(root.turn.id).pipe(Effect.mapError(mapError))
        const units = projection?.units ?? [root.unit]
        const rootLink = childLink(root.unit)
        if (rootLink === undefined)
          return yield* QueryError.make({ message: `Child execution ${childExecutionId} has no parent block` })
        const rootParentId = rootLink.parentId
        const descendants: Array<TranscriptUnit.Unit> = []
        const parentIds = new Set([rootParentId])
        for (const unit of units) {
          if (unit.parentId === undefined || !parentIds.has(unit.parentId)) continue
          descendants.push(unit)
          const link = childLink(unit)
          if (link !== undefined) parentIds.add(link.parentId)
        }
        const offset = Math.min(input.selector.offset ?? 0, descendants.length)
        const blockParents = new Map(
          descendants.flatMap((unit) => {
            const link = childLink(unit)
            return link === undefined ? [] : ([[link.parentId, unit]] as const)
          }),
        )
        const selected = new Set<TranscriptUnit.Unit>()
        let nextOffset = offset
        let forcedItem: ReadItem | undefined
        for (let index = offset; index < descendants.length; index += 1) {
          const candidate = descendants[index]!
          const trial = new Set(selected).add(candidate)
          let parentId = candidate.parentId
          while (parentId !== undefined && parentId !== rootParentId) {
            const parent = blockParents.get(parentId)
            if (parent === undefined) break
            trial.add(parent)
            parentId = parent.parentId
          }
          const result = {
            ...base,
            items: [
              subtreeItem(
                root.turn,
                root.unit,
                descendants.filter((unit) => trial.has(unit)),
              ),
            ],
            omissions: [],
            truncated: false,
          }
          if (encodeJson(result).length > transcriptBudget) {
            if (selected.size === 0) {
              selected.add(candidate)
              nextOffset = index + 1
              forcedItem = boundedSubtreeItem(root.turn, root.unit, candidate)
            }
            break
          }
          for (const unit of trial) selected.add(unit)
          nextOffset = index + 1
        }
        const continuation =
          nextOffset < descendants.length
            ? [{ reason: "responseBudget" as const, continuation: { ...input.selector, offset: nextOffset } }]
            : []
        return {
          ...base,
          items: [
            forcedItem ??
              subtreeItem(
                root.turn,
                root.unit,
                descendants.filter((unit) => selected.has(unit)),
              ),
          ],
          omissions: continuation,
          truncated: continuation.length > 0,
        }
      }
      if (input.selector._tag === "relevant") {
        const limit = yield* bounded("limit", input.selector.limit, 10, 20)
        const page = yield* transcripts
          .page(threadId, { before: input.selector.before, limit: 200 })
          .pipe(Effect.mapError(mapError))
        const needle = input.selector.query.toLocaleLowerCase()
        const entries = page.entries
          .filter(
            (entry) =>
              entry.unit.content._tag === "Entry" && entry.unit.content.text.toLocaleLowerCase().includes(needle),
          )
          .slice(-limit)
        const grouped = new Map<string, typeof entries>()
        for (const entry of entries) grouped.set(entry.turn.id, [...(grouped.get(entry.turn.id) ?? []), entry])
        const candidates = [...grouped.values()].map((values) =>
          item(
            values[0]!.turn,
            values.map((value) => value.unit),
          ),
        )
        const omissions: ReadonlyArray<Omission> =
          page.hasOlder && page.oldestCursor !== undefined
            ? [{ reason: "olderTurns", continuation: { ...input.selector, before: page.oldestCursor } }]
            : []
        return encodeBounded(
          { ...base, ...(page.oldestCursor === undefined ? {} : { nextCursor: page.oldestCursor }) },
          candidates,
          omissions,
        )
      }
      const limit = yield* bounded("limit", input.selector.limit, 10, 20)
      const page = yield* turns.page(threadId, { before: input.selector.before, limit }).pipe(Effect.mapError(mapError))
      const candidates = yield* Effect.forEach(page.turns, (turn) =>
        transcripts.get(turn.id).pipe(
          Effect.mapError(mapError),
          Effect.map((projection) => item(turn, projection?.units ?? [])),
        ),
      )
      const omissions: ReadonlyArray<Omission> =
        page.hasOlder && page.oldestCursor !== undefined
          ? [{ reason: "olderTurns", continuation: { ...input.selector, before: page.oldestCursor } }]
          : []
      return encodeBounded(
        { ...base, ...(page.oldestCursor === undefined ? {} : { nextCursor: page.oldestCursor }) },
        candidates,
        omissions,
      )
    })
    const search = Effect.fn("ThreadQuery.search")(function* (input: FindInput) {
      const result = yield* find(input)
      return { text: encodeJson(result), truncated: result.truncated }
    })
    const read = Effect.fn("ThreadQuery.read")(function* (input: LegacyReadInput) {
      const limit = yield* bounded("maxTurns", input.maxTurns, 10, 20)
      yield* bounded("maxChars", input.maxChars, transcriptBudget, transcriptBudget)
      const result = yield* readStructured({
        threadId: input.threadId,
        selector: { _tag: "recent", limit },
        ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
      })
      return { text: encodeJson(result), truncated: result.truncated }
    })
    return Service.of({ find, search, readStructured, read })
  })
export const layerForWorkspace = (workspace: string) => Layer.effect(Service, makeForWorkspace(workspace))
export const factoryLayer = Layer.effect(
  Factory,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | ThreadRepository.Service
      | ThreadSearchRepository.Service
      | ThreadInteractionRepository.Service
      | TurnRepository.Service
      | TranscriptRepository.Service
    >()
    return Factory.of({
      forWorkspace: (workspace) => makeForWorkspace(workspace).pipe(Effect.provideContext(context)),
    })
  }),
)
export const layer = layerForWorkspace("")
export const testLayer = (service: Interface) => Layer.succeed(Service, Service.of(service))
