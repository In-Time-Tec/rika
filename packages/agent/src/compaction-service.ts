import { Config, IdGenerator, Time } from "@rika/core"
import { Errors, ModelInfo, Modes, Provider, Router, Tokens } from "@rika/llm"
import { Database, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message, Tool } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as ModelContext from "./model-context"

const defaultTailTurns = 2
const toolOutputMaxChars = 2_000
const minimumTailBudget = 2_000
const maximumTailBudget = 8_000

export interface CompactInput extends Schema.Schema.Type<typeof CompactInput> {}
export const CompactInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  trigger: Event.ContextCompactionTrigger,
  preserve_from_sequence: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.CompactionService.CompactInput" })

export interface CompactionResult extends Schema.Schema.Type<typeof CompactionResult> {}
export const CompactionResult = Schema.Struct({
  event: Event.ContextCompacted,
  tokens_before: Schema.Int,
}).annotate({ identifier: "Rika.Agent.CompactionService.CompactionResult" })

export class CompactionError extends Schema.TaggedErrorClass<CompactionError>()("CompactionError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
  cause: Schema.optional(Schema.Unknown),
}) {}

export type RunError =
  | CompactionError
  | Config.ConfigError
  | Database.DatabaseError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError
  | Router.RouterError
  | Provider.ProviderError

export interface Interface {
  readonly compact: (input: CompactInput) => Effect.Effect<CompactionResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/CompactionService") {}

interface Dependencies {
  readonly config: Config.Interface
  readonly database: Database.Interface
  readonly eventLog: ThreadEventLog.Interface
  readonly projection: ThreadProjection.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
  readonly router: Router.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const projection = yield* ThreadProjection.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const router = yield* Router.Service
    const dependencies: Dependencies = { config, database, eventLog, projection, idGenerator, time, router }

    return Service.of({
      compact: Effect.fn("CompactionService.compact")(function* (input: CompactInput) {
        return yield* compactThread(dependencies, input)
      }),
    })
  }),
)

export const fakeLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

export const compact = Effect.fn("CompactionService.compact.call")(function* (input: CompactInput) {
  const service = yield* Service
  return yield* service.compact(input)
})

const compactThread = (dependencies: Dependencies, input: CompactInput) =>
  Effect.gen(function* () {
    const events = yield* readThread(dependencies, input.thread_id)
    if (events.length === 0) {
      return yield* new CompactionError({
        message: `Thread ${input.thread_id} does not exist`,
        operation: "compact",
        thread_id: input.thread_id,
      })
    }

    const previous = latestCompaction(events)
    const tokensBefore = Tokens.estimateMessages(ModelContext.messagesFromEvents(events))
    const tailStartSequence = yield* selectTailStartSequence(
      dependencies,
      events,
      previous,
      input.preserve_from_sequence,
    )
    const summarizerMessages = summarizerInput(events, previous, tailStartSequence)
    const response = yield* completeWithOverflowRetry(dependencies, input.thread_id, summarizerMessages)
    const event = yield* makeCompactedEvent(
      dependencies,
      input,
      latestSequence(events) + 1,
      response.content.trim(),
      tailStartSequence,
      tokensBefore,
      response.model,
    )
    const appended = yield* appendAndProject(dependencies, event)
    return { event: appended, tokens_before: tokensBefore }
  })

const readThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.eventLog
    .readThread({ thread_id: threadId })
    .pipe(Effect.provideService(Database.Service, dependencies.database))

const appendAndProject = (dependencies: Dependencies, event: Event.ContextCompacted) =>
  Effect.gen(function* () {
    const appended = yield* dependencies.eventLog
      .append(event)
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    yield* dependencies.projection.apply(appended).pipe(Effect.provideService(Database.Service, dependencies.database))
    if (appended.type !== "context.compacted") {
      return yield* new CompactionError({
        message: `Expected context.compacted event, received ${appended.type}`,
        operation: "compact",
        thread_id: event.thread_id,
      })
    }
    return appended
  })

const selectTailStartSequence = (
  dependencies: Dependencies,
  events: ReadonlyArray<Event.Event>,
  previous: Event.ContextCompacted | undefined,
  preserveFromSequence: number | undefined,
) =>
  Effect.gen(function* () {
    const config = yield* dependencies.config.get
    const model = Modes.primaryModel(Modes.get(config.default_mode))
    const usable = ModelInfo.usableBudget(ModelInfo.modelInfo(model))
    const budget = Math.min(maximumTailBudget, Math.max(minimumTailBudget, Math.floor(usable * 0.25)))
    const startSequence = turnTailStartSequence(events, defaultTailTurns)
    let tail = events.filter((event) => event.sequence >= startSequence)
    let trimmed = false
    while (tail.length > 1 && Tokens.estimateMessages(ModelContext.messagesFromEvents(tail)) > budget) {
      const messageIndex = tail.findIndex((event) => event.type === "message.added")
      tail = tail.slice(messageIndex < 0 ? 1 : messageIndex + 1)
      trimmed = true
    }
    const selected = !trimmed
      ? (tail[0]?.sequence ?? latestSequence(events) + 1)
      : (tail.find((event) => event.type === "message.added")?.sequence ?? latestSequence(events) + 1)
    const anchored = previous === undefined ? selected : Math.max(selected, previous.data.tail_start_sequence)
    const previousTail = previous?.data.tail_start_sequence ?? 1
    if (preserveFromSequence === undefined || preserveFromSequence < previousTail) return anchored
    return Math.min(anchored, preserveFromSequence)
  })

const turnTailStartSequence = (events: ReadonlyArray<Event.Event>, tailTurns: number) => {
  const starts = events.filter((event): event is Event.TurnStarted => event.type === "turn.started")
  const start = starts.at(-tailTurns)
  return start?.sequence ?? events[0]?.sequence ?? 1
}

const latestCompaction = (events: ReadonlyArray<Event.Event>) =>
  events.findLast((event): event is Event.ContextCompacted => event.type === "context.compacted")

const summarizerInput = (
  events: ReadonlyArray<Event.Event>,
  previous: Event.ContextCompacted | undefined,
  tailStartSequence: number,
): ReadonlyArray<Provider.Message> => [
  summarizerSystemMessage(),
  ...(previous === undefined ? [] : [previousSummaryMessage(previous)]),
  ...events
    .filter((event) => event.sequence < tailStartSequence)
    .filter((event) => previous === undefined || event.sequence >= previous.data.tail_start_sequence)
    .flatMap(summarizerMessageFromEvent),
]

const summarizerSystemMessage = (): Provider.Message => ({
  role: "system",
  content: [
    "Summarize only the supplied Rika thread history.",
    "If a <previous-summary> block is present, update that anchor by preserving still-true facts, dropping stale details, and merging new facts.",
    "Never mention compaction.",
    "Return Markdown with every section present:",
    "Goal",
    "Constraints & Preferences",
    "Progress",
    "Done",
    "In Progress",
    "Blocked",
    "Key Decisions",
    "Next Steps",
    "Critical Context",
    "Relevant Files",
    "Use terse bullets. Preserve exact file paths, commands, error strings, identifiers, and unresolved blockers.",
  ].join("\n"),
})

const previousSummaryMessage = (event: Event.ContextCompacted): Provider.Message => ({
  role: "user",
  content: `<previous-summary>\n${event.data.summary}\n</previous-summary>`,
})

const summarizerMessageFromEvent = (event: Event.Event): ReadonlyArray<Provider.Message> => {
  switch (event.type) {
    case "message.added":
      return messageSummary(event.data.message)
    case "tool.call.completed":
      return [{ role: "tool", content: JSON.stringify(cappedToolResult(event.data.result)) }]
    default:
      return []
  }
}

const messageSummary = (message: Message.Message): ReadonlyArray<Provider.Message> => {
  const content = Message.displayText(stripImages(message))
  if (content.length === 0) return []
  switch (message.role) {
    case "system":
      return [{ role: "system", content }]
    case "assistant":
      return [{ role: "assistant", content }]
    case "tool":
      return [{ role: "tool", content }]
    case "user":
      return [{ role: "user", content }]
  }
  return []
}

const stripImages = (message: Message.Message): Message.Message => ({
  ...message,
  content: message.content.filter((part) => part.type !== "image"),
})

const cappedToolResult = (result: Tool.Result): Tool.Result => {
  if (result.status !== "success" || result.output === undefined) return result
  const output = JSON.stringify(result.output)
  if (output.length <= toolOutputMaxChars) return result
  return {
    ...result,
    output: {
      truncated: true,
      chars: output.length,
      preview: output.slice(0, toolOutputMaxChars),
    },
  }
}

const completeWithOverflowRetry = (
  dependencies: Dependencies,
  threadId: Ids.ThreadId,
  messages: ReadonlyArray<Provider.Message>,
): Effect.Effect<Provider.GenerateResponse, RunError> =>
  dependencies.router.complete({ profile: "compaction", messages }).pipe(
    Effect.flatMap((response) =>
      Errors.isZeroProgressLengthResponse(response)
        ? retryCompactionAfterOverflow(dependencies, threadId, messages, response)
        : Effect.succeed(response),
    ),
    Effect.catch((error) => {
      if (!Errors.isContextOverflow(error)) return Effect.fail(error)
      return retryCompactionAfterOverflow(dependencies, threadId, messages, error)
    }),
  )

const retryCompactionAfterOverflow = (
  dependencies: Dependencies,
  threadId: Ids.ThreadId,
  messages: ReadonlyArray<Provider.Message>,
  cause: unknown,
): Effect.Effect<Provider.GenerateResponse, RunError> => {
  const retryMessages = dropOldestConversationMessage(messages)
  if (retryMessages === undefined) {
    return Effect.fail(
      new CompactionError({
        message: "thread too large to compact",
        operation: "compact",
        thread_id: threadId,
        cause,
      }),
    )
  }
  return completeWithOverflowRetry(dependencies, threadId, retryMessages)
}

const dropOldestConversationMessage = (
  messages: ReadonlyArray<Provider.Message>,
): ReadonlyArray<Provider.Message> | undefined => {
  const indexes = messages.flatMap((message, position) =>
    position > 0 && !(message.role === "user" && textContent(message.content).startsWith("<previous-summary>"))
      ? [position]
      : [],
  )
  if (indexes.length <= 1) return undefined
  const index = indexes[0] ?? -1
  if (index < 0) return undefined
  return [...messages.slice(0, index), ...messages.slice(index + 1)]
}

const textContent = (content: Provider.MessageContent) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")

const makeCompactedEvent = (
  dependencies: Dependencies,
  input: CompactInput,
  sequence: number,
  summary: string,
  tailStartSequence: number,
  tokensBefore: number,
  model: string,
) =>
  Effect.gen(function* () {
    if (summary.length === 0) {
      return yield* new CompactionError({
        message: "Compaction summary was empty",
        operation: "compact",
        thread_id: input.thread_id,
      })
    }
    const createdAt = yield* dependencies.time.nowMillis
    const id = Ids.EventId.make(yield* dependencies.idGenerator.next("event"))
    const event: Event.ContextCompacted = {
      id,
      thread_id: input.thread_id,
      sequence,
      version: 1,
      created_at: Common.TimestampMillis.make(createdAt),
      type: "context.compacted",
      data: {
        summary,
        tail_start_sequence: tailStartSequence,
        trigger: input.trigger,
        tokens_before: tokensBefore,
        model,
      },
    }
    return event
  })

const latestSequence = (events: ReadonlyArray<Event.Event>) => events.at(-1)?.sequence ?? 0
