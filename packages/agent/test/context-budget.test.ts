import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Tokens } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message, Tool } from "@rika/schema"
import { Effect, Layer } from "effect"
import { ContextBudget, ModelContext, ThreadService } from "../src/index"

const threadId = Ids.ThreadId.make("thread_context_budget")
const workspaceId = Ids.WorkspaceId.make("workspace_context_budget")
const turnId = Ids.TurnId.make("turn_context_budget")
const now = Common.TimestampMillis.make(1_970_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-context-budget-test",
  data_dir: "/workspace/rika-context-budget-test/.rika",
  default_mode: "deep1",
})
const redactorLayer = SecretRedactor.layer
const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))

const services = Layer.mergeAll(
  configLayer,
  Database.memoryLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  Time.fixedLayer(now),
  IdGenerator.sequenceLayer(1),
  redactorLayer,
  diagnosticsLayer,
)

const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(services), Layer.provideMerge(diagnosticsLayer))
const layer = ContextBudget.layer.pipe(Layer.provideMerge(threadLayer))

describe("ContextBudget", () => {
  test("uses the last recorded context token sample", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        for (const event of [modelChunk(), turnCompletedWithUsage()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ContextBudget.state({ thread_id: threadId, mode: "deep1" })
      }).pipe(Effect.provide(layer)),
    )

    expect(state).toEqual({ used: 42_000, usable: 380_000, fraction: 42_000 / 380_000 })
  })

  test("estimates from replayed provider messages when no usage sample exists", async () => {
    const event = messageAdded()
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        const appended = yield* ThreadEventLog.append(event)
        yield* ThreadProjection.apply(appended)
        return yield* ContextBudget.state({ thread_id: threadId, mode: "smart" })
      }).pipe(Effect.provide(layer)),
    )

    const used = Tokens.estimateMessages(ModelContext.messagesFromEvents([event]))
    expect(state).toEqual({ used, usable: 180_000, fraction: used / 180_000 })
  })

  test("applies an explicit reserved token buffer to the usable budget", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        for (const event of [modelChunk(), turnCompletedWithUsage()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ContextBudget.state({ thread_id: threadId, mode: "deep1", reserved: 50_000 })
      }).pipe(Effect.provide(layer)),
    )

    expect(state).toEqual({ used: 42_000, usable: 350_000, fraction: 42_000 / 350_000 })
  })

  test("estimates folded events when compaction is newer than the usage sample", async () => {
    const compaction = contextCompacted()
    const events = [modelChunk(), turnCompletedWithUsage(), compaction]
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        for (const event of events) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ContextBudget.state({ thread_id: threadId, mode: "deep1" })
      }).pipe(Effect.provide(layer)),
    )

    const used = Tokens.estimateMessages(ModelContext.messagesFromEvents([threadCreated(), ...events]))
    expect(state).toEqual({ used, usable: 380_000, fraction: used / 380_000 })
  })

  test("estimates folded events when pruning is newer than the usage sample", async () => {
    const events = [
      toolCompletedWithOutput({ content: "bulky output ".repeat(200) }),
      turnCompletedWithUsage(),
      contextPruned(),
    ]
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        for (const event of events) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ContextBudget.state({ thread_id: threadId, mode: "deep1" })
      }).pipe(Effect.provide(layer)),
    )

    const used = Tokens.estimateMessages(ModelContext.messagesFromEvents([threadCreated(), ...events]))
    expect(state).toEqual({ used, usable: 380_000, fraction: used / 380_000 })
    expect(state.used).not.toBe(42_000)
  })
})

const threadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("context_budget_thread_created"),
  thread_id: threadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const modelChunk = (): Event.ModelStreamChunk => ({
  id: Ids.EventId.make("context_budget_model_chunk"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "model.stream.chunk",
  data: { provider: "openai", model: "gpt-5.5", text: "answer" },
})

const turnCompletedWithUsage = (): Event.TurnCompleted => ({
  id: Ids.EventId.make("context_budget_turn_completed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 3,
  version: 1,
  created_at: now,
  type: "turn.completed",
  data: { usage: { input_tokens: 42_000, output_tokens: 100, total_tokens: 42_100 } },
})

const contextCompacted = (): Event.ContextCompacted => ({
  id: Ids.EventId.make("context_budget_compacted"),
  thread_id: threadId,
  sequence: 4,
  version: 1,
  created_at: now,
  type: "context.compacted",
  data: {
    summary: "folded context summary",
    tail_start_sequence: 4,
    trigger: "auto",
    tokens_before: 42_000,
    model: "gpt-5.5",
  },
})

const contextPruned = (): Event.ContextPruned => ({
  id: Ids.EventId.make("context_budget_pruned"),
  thread_id: threadId,
  sequence: 4,
  version: 1,
  created_at: now,
  type: "context.pruned",
  data: {
    tool_call_ids: [Ids.ToolCallId.make("context_budget_tool")],
    estimated_tokens_freed: 10_000,
  },
})

const toolCompletedWithOutput = (output: NonNullable<Tool.Result["output"]>): Event.ToolCallCompleted => ({
  id: Ids.EventId.make("context_budget_tool_completed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make("context_budget_tool"),
      name: "read",
      status: "success",
      output,
    },
  },
})

const messageAdded = (): Event.MessageAdded => ({
  id: Ids.EventId.make("context_budget_message_event"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("context_budget_message"),
      thread_id: threadId,
      turn_id: turnId,
      created_at: now,
      content: "Estimate this prompt",
    }),
  },
})
