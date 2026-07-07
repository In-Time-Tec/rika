import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router, Tokens } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message, Tool } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { CompactionService, ThreadService } from "../src/index"

const threadId = Ids.ThreadId.make("thread_compaction_service")
const workspaceId = Ids.WorkspaceId.make("workspace_compaction_service")
const now = Common.TimestampMillis.make(1_971_000_000_000)

const configValues = {
  workspace_root: "/workspace/rika-compaction-test",
  data_dir: "/workspace/rika-compaction-test/.rika",
  default_mode: "deep1" as const,
}

const makeLayer = (
  captured: Array<Router.Request>,
  responses: ReadonlyArray<Provider.GenerateResponse | Router.RouterError>,
  config: Config.Values = configValues,
) => {
  let index = 0
  const routerLayer = Layer.succeed(
    Router.Service,
    Router.Service.of({
      route: (request) =>
        Effect.succeed({
          mode: request.mode ?? "deep1",
          profile: request.profile,
          provider: request.provider ?? "openai",
          model: request.model ?? "gpt-5.5",
          messages: request.messages,
          reasoning_effort: request.reasoning_effort ?? "low",
        }),
      complete: (request) =>
        Effect.gen(function* () {
          captured.push(request)
          const response = responses[index] ?? responseWith("fallback summary")
          index += 1
          if (response instanceof Router.RouterError) return yield* response
          return response
        }),
      completeStructured: () => Effect.die(new Error("structured completion not configured")),
      stream: () => Stream.empty,
    }),
  )
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const services = Layer.mergeAll(
    Config.layerFromValues(config),
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
    redactorLayer,
    diagnosticsLayer,
    routerLayer,
  )
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(services), Layer.provideMerge(diagnosticsLayer))

  return CompactionService.layer.pipe(Layer.provideMerge(threadLayer))
}

describe("CompactionService", () => {
  test("appends a context.compacted event with a summary and last two turns as the tail", async () => {
    const captured: Array<Router.Request> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        const compacted = yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { compacted, events }
      }).pipe(Effect.provide(makeLayer(captured, [responseWith("Fresh anchored summary")]))),
    )

    expect(result.compacted.event).toMatchObject({
      type: "context.compacted",
      thread_id: threadId,
      sequence: 15,
      data: {
        summary: "Fresh anchored summary",
        tail_start_sequence: 9,
        trigger: "manual",
        model: "gpt-5.5",
      },
    })
    expect(result.events.at(-1)).toEqual(result.compacted.event)
    expect(captured[0]).toMatchObject({ profile: "compaction" })
    expect(JSON.stringify(captured[0]?.messages)).toContain("first tool result")
    expect(JSON.stringify(captured[0]?.messages)).toContain("second user message")
    expect(JSON.stringify(captured[0]?.messages)).not.toContain("third user message")
  })

  test("passes the previous compaction summary as the anchor on later compactions", async () => {
    const captured: Array<Router.Request> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        const prior = contextCompacted(15, "Existing summary", 9)
        const appended = yield* ThreadEventLog.append(prior)
        yield* ThreadProjection.apply(appended)
        const extra = messageAdded(16, Ids.TurnId.make("turn_compaction_5"), "new final user message")
        const appendedExtra = yield* ThreadEventLog.append(extra)
        yield* ThreadProjection.apply(appendedExtra)
        return yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
      }).pipe(Effect.provide(makeLayer(captured, [responseWith("Updated summary")]))),
    )

    const promptText = JSON.stringify(captured[0]?.messages)
    expect(promptText).toContain("<previous-summary>")
    expect(promptText).toContain("Existing summary")
    expect(promptText).toContain("</previous-summary>")
  })

  test("drops the oldest summarizer message and retries once after context overflow", async () => {
    const captured: Array<Router.Request> = []
    const overflow = new Router.RouterError({
      message: "maximum context tokens exceeded",
      profile: "compaction",
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
      }).pipe(Effect.provide(makeLayer(captured, [overflow, responseWith("Recovered summary")]))),
    )

    expect(captured).toHaveLength(2)
    expect(JSON.stringify(captured[0]?.messages)).toContain("first user message")
    expect(JSON.stringify(captured[1]?.messages)).not.toContain("first user message")
    expect(JSON.stringify(captured[1]?.messages)).toContain("second user message")
  })

  test("drops the oldest summarizer message and retries after zero-progress length response", async () => {
    const captured: Array<Router.Request> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        const result = yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { result, events }
      }).pipe(
        Effect.provide(
          makeLayer(captured, [
            {
              provider: "openai",
              model: "gpt-5.5",
              content: "",
              finish_reason: "length",
            },
            responseWith("Recovered length summary"),
          ]),
        ),
      ),
    )

    expect(captured).toHaveLength(2)
    expect(JSON.stringify(captured[0]?.messages)).toContain("first user message")
    expect(JSON.stringify(captured[1]?.messages)).not.toContain("first user message")
    expect(JSON.stringify(captured[1]?.messages)).toContain("second user message")
  })

  test("strips image content and caps oversized tool output before summarizing", async () => {
    const captured: Array<Router.Request> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThreadWithPromptHygieneFixtures()
        return yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
      }).pipe(Effect.provide(makeLayer(captured, [responseWith("Hygiene summary")]))),
    )

    const promptText = JSON.stringify(captured[0]?.messages)
    expect(promptText).toContain("image turn text")
    expect(promptText).not.toContain("base64-sensitive-image")
    expect(promptText).not.toContain("screenshot.png")
    const toolMessage = captured[0]?.messages.find((message) => message.role === "tool")
    const toolContent = toolMessage?.content
    if (typeof toolContent !== "string") throw new Error("Expected a string tool message")
    const parsedTool = JSON.parse(toolContent)
    expect(parsedTool.output.truncated).toBe(true)
    expect(parsedTool.output.preview.length).toBeLessThanOrEqual(2_000)
    expect(promptText).not.toContain("SHOULD_NOT_SURVIVE")
  })

  test("trims an oversized tail only at message boundaries", async () => {
    const captured: Array<Router.Request> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThreadWithOversizedTailMessage()
        return yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
      }).pipe(Effect.provide(makeLayer(captured, [responseWith("Boundary summary")]))),
    )

    expect(result.event.data.tail_start_sequence).toBe(9)
  })

  test("does not move a repeated compaction tail behind the previous anchor", async () => {
    const captured: Array<Router.Request> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThreadWithOversizedTailMessage()
        const prior = contextCompacted(11, "Existing anchor", 9)
        const appendedPrior = yield* ThreadEventLog.append(prior)
        yield* ThreadProjection.apply(appendedPrior)
        for (const event of [
          turnStarted(12, Ids.TurnId.make("turn_compaction_after_prior")),
          messageAdded(13, Ids.TurnId.make("turn_compaction_after_prior"), "new message after prior compaction"),
          turnCompleted(14, Ids.TurnId.make("turn_compaction_after_prior")),
        ]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" })
      }).pipe(Effect.provide(makeLayer(captured, [responseWith("Repeated summary")]))),
    )

    expect(result.event.data.tail_start_sequence).toBe(9)
    expect(JSON.stringify(captured[0]?.messages)).not.toContain("BBBB")
  })

  test("fails instead of dropping the last unsummarized message after overflow", async () => {
    const captured: Array<Router.Request> = []
    const overflow = new Router.RouterError({
      message: "maximum context tokens exceeded",
      profile: "compaction",
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThreadWithSingleFoldedMessage()
        const error = yield* CompactionService.compact({ thread_id: threadId, trigger: "manual" }).pipe(Effect.flip)
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { error, events }
      }).pipe(Effect.provide(makeLayer(captured, [overflow, responseWith("empty summary should not append")]))),
    )

    expect(result.error).toBeInstanceOf(CompactionService.CompactionError)
    expect(result.error.message).toBe("thread too large to compact")
    expect(captured).toHaveLength(1)
    expect(result.events.map((event) => event.type)).not.toContain("context.compacted")
  })

  test("prunes old tool outputs while protecting the last two turns and the newest protected window", async () => {
    const captured: Array<Router.Request> = []
    const outputOld = { content: "old candidate output ".repeat(8) }
    const outputAlready = { content: "already pruned output ".repeat(8) }
    const outputProtected = { content: "protected output ".repeat(8) }
    const oldTokens = toolOutputTokens(outputOld)
    const protectedTokens = toolOutputTokens(outputProtected)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedPruneThread({ outputOld, outputAlready, outputProtected })
        const pruned = yield* CompactionService.prune({ thread_id: threadId })
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { pruned, events }
      }).pipe(
        Effect.provide(
          makeLayer(captured, [], {
            ...configValues,
            compaction_prune_protect: protectedTokens,
            compaction_prune_minimum: oldTokens,
          }),
        ),
      ),
    )

    expect(result.pruned).toMatchObject({
      tool_call_ids: [Ids.ToolCallId.make("tool_prune_old")],
      estimated_tokens_freed: oldTokens,
    })
    expect(result.pruned.event).toMatchObject({
      type: "context.pruned",
      sequence: 18,
      data: {
        tool_call_ids: [Ids.ToolCallId.make("tool_prune_old")],
        estimated_tokens_freed: oldTokens,
      },
    })
    expect(result.events.at(-1)).toEqual(result.pruned.event)
  })

  test("prunes a single old tool output that crosses the protected window", async () => {
    const captured: Array<Router.Request> = []
    const output = { content: "boundary output ".repeat(64) }
    const outputTokenCount = toolOutputTokens(output)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedBoundaryPruneThread(output)
        return yield* CompactionService.prune({ thread_id: threadId })
      }).pipe(
        Effect.provide(
          makeLayer(captured, [], {
            ...configValues,
            compaction_prune_protect: Math.floor(outputTokenCount / 2),
            compaction_prune_minimum: outputTokenCount,
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      tool_call_ids: [Ids.ToolCallId.make("tool_prune_boundary")],
      estimated_tokens_freed: outputTokenCount,
    })
  })

  test("does not append a prune event when candidates are below the minimum", async () => {
    const captured: Array<Router.Request> = []
    const outputOld = { content: "small old output" }
    const outputAlready = { content: "already pruned output" }
    const outputProtected = { content: "protected output" }
    const oldTokens = toolOutputTokens(outputOld)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedPruneThread({ outputOld, outputAlready, outputProtected })
        const pruned = yield* CompactionService.prune({ thread_id: threadId })
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { pruned, events }
      }).pipe(
        Effect.provide(
          makeLayer(captured, [], {
            ...configValues,
            compaction_prune_protect: toolOutputTokens(outputProtected),
            compaction_prune_minimum: oldTokens + 1,
          }),
        ),
      ),
    )

    expect(result.pruned).toEqual({ tool_call_ids: [], estimated_tokens_freed: 0 })
    expect(result.events.map((event) => event.type)).toContain("context.pruned")
    expect(result.events.at(-1)?.type).toBe("turn.completed")
  })

  test("pruning stops at the latest compaction boundary", async () => {
    const captured: Array<Router.Request> = []
    const beforeCompaction = { content: "before compaction ".repeat(24) }
    const afterCompaction = { content: "after compaction ".repeat(24) }
    const afterTokens = toolOutputTokens(afterCompaction)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedPruneThreadWithCompaction({ beforeCompaction, afterCompaction })
        const pruned = yield* CompactionService.prune({ thread_id: threadId })
        return pruned
      }).pipe(
        Effect.provide(
          makeLayer(captured, [], {
            ...configValues,
            compaction_prune_protect: 0,
            compaction_prune_minimum: afterTokens,
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      tool_call_ids: [Ids.ToolCallId.make("tool_prune_after_compaction")],
      estimated_tokens_freed: afterTokens,
    })
  })

  test("prunes tool outputs retained in the latest compaction tail", async () => {
    const captured: Array<Router.Request> = []
    const retained = { content: "retained compaction tail output ".repeat(24) }
    const retainedTokens = toolOutputTokens(retained)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedPruneThreadWithRetainedCompactionTail(retained)
        return yield* CompactionService.prune({ thread_id: threadId })
      }).pipe(
        Effect.provide(
          makeLayer(captured, [], {
            ...configValues,
            compaction_prune_protect: 0,
            compaction_prune_minimum: retainedTokens,
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      tool_call_ids: [Ids.ToolCallId.make("tool_prune_retained_tail")],
      estimated_tokens_freed: retainedTokens,
    })
  })
})

const seedThread = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_compaction_1")),
      messageAdded(3, Ids.TurnId.make("turn_compaction_1"), "first user message"),
      toolCompleted(4, Ids.TurnId.make("turn_compaction_1"), Ids.ToolCallId.make("tool_compaction_1"), {
        content: "first tool result",
      }),
      turnCompleted(5, Ids.TurnId.make("turn_compaction_1")),
      turnStarted(6, Ids.TurnId.make("turn_compaction_2")),
      messageAdded(7, Ids.TurnId.make("turn_compaction_2"), "second user message"),
      turnCompleted(8, Ids.TurnId.make("turn_compaction_2")),
      turnStarted(9, Ids.TurnId.make("turn_compaction_3")),
      messageAdded(10, Ids.TurnId.make("turn_compaction_3"), "third user message"),
      turnCompleted(11, Ids.TurnId.make("turn_compaction_3")),
      turnStarted(12, Ids.TurnId.make("turn_compaction_4")),
      messageAdded(13, Ids.TurnId.make("turn_compaction_4"), "fourth user message"),
      turnCompleted(14, Ids.TurnId.make("turn_compaction_4")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedThreadWithPromptHygieneFixtures = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_compaction_hygiene_1")),
      messageAddedWithParts(3, Ids.TurnId.make("turn_compaction_hygiene_1"), [
        Message.text("image turn text"),
        Message.image({
          media_type: "image/png",
          data: "base64-sensitive-image",
          filename: "screenshot.png",
        }),
      ]),
      toolCompleted(4, Ids.TurnId.make("turn_compaction_hygiene_1"), Ids.ToolCallId.make("tool_hygiene_1"), {
        content: `${"A".repeat(2_500)}SHOULD_NOT_SURVIVE`,
      }),
      turnCompleted(5, Ids.TurnId.make("turn_compaction_hygiene_1")),
      turnStarted(6, Ids.TurnId.make("turn_compaction_hygiene_2")),
      messageAdded(7, Ids.TurnId.make("turn_compaction_hygiene_2"), "second hygiene user message"),
      turnCompleted(8, Ids.TurnId.make("turn_compaction_hygiene_2")),
      turnStarted(9, Ids.TurnId.make("turn_compaction_hygiene_3")),
      messageAdded(10, Ids.TurnId.make("turn_compaction_hygiene_3"), "third hygiene user message"),
      turnCompleted(11, Ids.TurnId.make("turn_compaction_hygiene_3")),
      turnStarted(12, Ids.TurnId.make("turn_compaction_hygiene_4")),
      messageAdded(13, Ids.TurnId.make("turn_compaction_hygiene_4"), "fourth hygiene user message"),
      turnCompleted(14, Ids.TurnId.make("turn_compaction_hygiene_4")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedThreadWithOversizedTailMessage = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_compaction_boundary_1")),
      messageAdded(3, Ids.TurnId.make("turn_compaction_boundary_1"), "first boundary user message"),
      turnCompleted(4, Ids.TurnId.make("turn_compaction_boundary_1")),
      turnStarted(5, Ids.TurnId.make("turn_compaction_boundary_2")),
      messageAdded(6, Ids.TurnId.make("turn_compaction_boundary_2"), "B".repeat(60_000)),
      turnCompleted(7, Ids.TurnId.make("turn_compaction_boundary_2")),
      turnStarted(8, Ids.TurnId.make("turn_compaction_boundary_3")),
      messageAdded(9, Ids.TurnId.make("turn_compaction_boundary_3"), "small latest user message"),
      turnCompleted(10, Ids.TurnId.make("turn_compaction_boundary_3")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedThreadWithSingleFoldedMessage = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_compaction_single_folded_1")),
      messageAdded(3, Ids.TurnId.make("turn_compaction_single_folded_1"), "only folded user message"),
      turnCompleted(4, Ids.TurnId.make("turn_compaction_single_folded_1")),
      turnStarted(5, Ids.TurnId.make("turn_compaction_single_folded_2")),
      messageAdded(6, Ids.TurnId.make("turn_compaction_single_folded_2"), "first tail message"),
      turnCompleted(7, Ids.TurnId.make("turn_compaction_single_folded_2")),
      turnStarted(8, Ids.TurnId.make("turn_compaction_single_folded_3")),
      messageAdded(9, Ids.TurnId.make("turn_compaction_single_folded_3"), "second tail message"),
      turnCompleted(10, Ids.TurnId.make("turn_compaction_single_folded_3")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedPruneThread = (input: {
  readonly outputOld: NonNullable<Tool.Result["output"]>
  readonly outputAlready: NonNullable<Tool.Result["output"]>
  readonly outputProtected: NonNullable<Tool.Result["output"]>
}) =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_prune_1")),
      toolCompleted(3, Ids.TurnId.make("turn_prune_1"), Ids.ToolCallId.make("tool_prune_old"), input.outputOld),
      turnCompleted(4, Ids.TurnId.make("turn_prune_1")),
      turnStarted(5, Ids.TurnId.make("turn_prune_2")),
      toolCompleted(6, Ids.TurnId.make("turn_prune_2"), Ids.ToolCallId.make("tool_prune_already"), input.outputAlready),
      turnCompleted(7, Ids.TurnId.make("turn_prune_2")),
      contextPruned(8, [Ids.ToolCallId.make("tool_prune_already")], toolOutputTokens(input.outputAlready)),
      turnStarted(9, Ids.TurnId.make("turn_prune_3")),
      toolCompleted(
        10,
        Ids.TurnId.make("turn_prune_3"),
        Ids.ToolCallId.make("tool_prune_protected"),
        input.outputProtected,
      ),
      turnCompleted(11, Ids.TurnId.make("turn_prune_3")),
      turnStarted(12, Ids.TurnId.make("turn_prune_4")),
      toolCompleted(13, Ids.TurnId.make("turn_prune_4"), Ids.ToolCallId.make("tool_prune_recent_1"), {
        content: "recent output one ".repeat(8),
      }),
      turnCompleted(14, Ids.TurnId.make("turn_prune_4")),
      turnStarted(15, Ids.TurnId.make("turn_prune_5")),
      toolCompleted(16, Ids.TurnId.make("turn_prune_5"), Ids.ToolCallId.make("tool_prune_recent_2"), {
        content: "recent output two ".repeat(8),
      }),
      turnCompleted(17, Ids.TurnId.make("turn_prune_5")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedPruneThreadWithCompaction = (input: {
  readonly beforeCompaction: NonNullable<Tool.Result["output"]>
  readonly afterCompaction: NonNullable<Tool.Result["output"]>
}) =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_prune_compaction_1")),
      toolCompleted(
        3,
        Ids.TurnId.make("turn_prune_compaction_1"),
        Ids.ToolCallId.make("tool_prune_before_compaction"),
        input.beforeCompaction,
      ),
      turnCompleted(4, Ids.TurnId.make("turn_prune_compaction_1")),
      contextCompacted(5, "Compacted boundary", 6),
      turnStarted(6, Ids.TurnId.make("turn_prune_compaction_2")),
      toolCompleted(
        7,
        Ids.TurnId.make("turn_prune_compaction_2"),
        Ids.ToolCallId.make("tool_prune_after_compaction"),
        input.afterCompaction,
      ),
      turnCompleted(8, Ids.TurnId.make("turn_prune_compaction_2")),
      turnStarted(9, Ids.TurnId.make("turn_prune_compaction_3")),
      messageAdded(10, Ids.TurnId.make("turn_prune_compaction_3"), "recent one"),
      turnCompleted(11, Ids.TurnId.make("turn_prune_compaction_3")),
      turnStarted(12, Ids.TurnId.make("turn_prune_compaction_4")),
      messageAdded(13, Ids.TurnId.make("turn_prune_compaction_4"), "recent two"),
      turnCompleted(14, Ids.TurnId.make("turn_prune_compaction_4")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedPruneThreadWithRetainedCompactionTail = (output: NonNullable<Tool.Result["output"]>) =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_prune_retained_tail_1")),
      toolCompleted(
        3,
        Ids.TurnId.make("turn_prune_retained_tail_1"),
        Ids.ToolCallId.make("tool_prune_retained_tail"),
        output,
      ),
      turnCompleted(4, Ids.TurnId.make("turn_prune_retained_tail_1")),
      contextCompacted(5, "Compacted with retained tail", 2),
      turnStarted(6, Ids.TurnId.make("turn_prune_retained_tail_2")),
      messageAdded(7, Ids.TurnId.make("turn_prune_retained_tail_2"), "recent one"),
      turnCompleted(8, Ids.TurnId.make("turn_prune_retained_tail_2")),
      turnStarted(9, Ids.TurnId.make("turn_prune_retained_tail_3")),
      messageAdded(10, Ids.TurnId.make("turn_prune_retained_tail_3"), "recent two"),
      turnCompleted(11, Ids.TurnId.make("turn_prune_retained_tail_3")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedBoundaryPruneThread = (output: NonNullable<Tool.Result["output"]>) =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [
      turnStarted(2, Ids.TurnId.make("turn_prune_boundary_old")),
      toolCompleted(3, Ids.TurnId.make("turn_prune_boundary_old"), Ids.ToolCallId.make("tool_prune_boundary"), output),
      turnCompleted(4, Ids.TurnId.make("turn_prune_boundary_old")),
      turnStarted(5, Ids.TurnId.make("turn_prune_boundary_recent_1")),
      messageAdded(6, Ids.TurnId.make("turn_prune_boundary_recent_1"), "recent one"),
      turnCompleted(7, Ids.TurnId.make("turn_prune_boundary_recent_1")),
      turnStarted(8, Ids.TurnId.make("turn_prune_boundary_recent_2")),
      messageAdded(9, Ids.TurnId.make("turn_prune_boundary_recent_2"), "recent two"),
      turnCompleted(10, Ids.TurnId.make("turn_prune_boundary_recent_2")),
    ]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const base = (sequence: number, turnId: Ids.TurnId): Omit<Event.TurnStarted, "type" | "data"> => ({
  id: Ids.EventId.make(`event_compaction_service_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
})

const turnStarted = (sequence: number, turnId: Ids.TurnId): Event.TurnStarted => ({
  ...base(sequence, turnId),
  type: "turn.started",
  data: {},
})

const messageAdded = (sequence: number, turnId: Ids.TurnId, content: string): Event.MessageAdded => ({
  ...base(sequence, turnId),
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_compaction_service_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: now,
    }),
  },
})

const messageAddedWithParts = (
  sequence: number,
  turnId: Ids.TurnId,
  content: ReadonlyArray<Message.ContentPart>,
): Event.MessageAdded => ({
  ...base(sequence, turnId),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_compaction_service_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role: "user",
      content,
      created_at: now,
    },
  },
})

const toolCompleted = (
  sequence: number,
  turnId: Ids.TurnId,
  id: Ids.ToolCallId,
  output: NonNullable<Tool.Result["output"]>,
): Event.ToolCallCompleted => ({
  ...base(sequence, turnId),
  type: "tool.call.completed",
  data: {
    result: {
      id,
      name: "read",
      status: "success",
      output,
    },
  },
})

const turnCompleted = (sequence: number, turnId: Ids.TurnId): Event.TurnCompleted => ({
  ...base(sequence, turnId),
  type: "turn.completed",
  data: { provider: "openai", model: "gpt-5.5" },
})

const contextCompacted = (sequence: number, summary: string, tailStartSequence: number): Event.ContextCompacted => ({
  id: Ids.EventId.make(`event_compaction_service_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "context.compacted",
  data: {
    summary,
    tail_start_sequence: tailStartSequence,
    trigger: "manual",
    model: "gpt-5.5",
  },
})

const contextPruned = (
  sequence: number,
  toolCallIds: ReadonlyArray<Ids.ToolCallId>,
  estimatedTokensFreed: number,
): Event.ContextPruned => ({
  id: Ids.EventId.make(`event_compaction_service_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "context.pruned",
  data: {
    tool_call_ids: [...toolCallIds],
    estimated_tokens_freed: estimatedTokensFreed,
  },
})

const responseWith = (content: string): Provider.GenerateResponse => ({
  provider: "openai",
  model: "gpt-5.5",
  content,
  finish_reason: "stop",
  usage: { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 },
})

const toolOutputTokens = (output: NonNullable<Tool.Result["output"]>) => Tokens.estimateTokens(JSON.stringify(output))
