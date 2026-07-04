import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "../src/index"

const threadId = Ids.ThreadId.make("thread_projection_thread")
const workspaceId = Ids.WorkspaceId.make("workspace_projection")
const turnId = Ids.TurnId.make("turn_projection")
const secondTurnId = Ids.TurnId.make("turn_projection_second")
const userId = Ids.UserId.make("user_projection")
const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer, ThreadProjection.layer)

describe("ThreadProjection", () => {
  test("projects thread list, latest message, and active turn state", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of projectionEvents()) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      latest_message_text: "hello projection",
      active_turn_id: turnId,
      active_turn_status: "completed",
      last_user_id: userId,
      archived: false,
    })
  })

  test("projects archive and unarchive events", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [...projectionEvents(), archivedEvent(), unarchivedEvent()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({ thread_id: threadId, archived: false })
  })

  test("projects thread visibility changes and rebuilds them from the event log", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [...projectionEvents(), visibilitySetEvent()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        const applied = yield* ThreadProjection.getThread(threadId)
        yield* ThreadProjection.clear()
        yield* ThreadProjection.rebuild()
        const rebuilt = yield* ThreadProjection.getThread(threadId)
        return { applied, rebuilt }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.applied).toMatchObject({ thread_id: threadId, visibility: "workspace" })
    expect(result.rebuilt).toEqual(result.applied)
  })

  test("rebuilds projections from only the event log", async () => {
    const summaries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of projectionEvents()) {
          yield* ThreadEventLog.append(event)
        }
        yield* ThreadProjection.clear()
        expect(yield* ThreadProjection.listThreads()).toEqual([])
        yield* ThreadProjection.rebuild()
        return yield* ThreadProjection.listThreads()
      }).pipe(Effect.provide(layer)),
    )

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      latest_message_text: "hello projection",
      active_turn_status: "completed",
      last_user_id: userId,
    })
  })

  test("projects stable thread titles and cumulative diff stats", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [...projectionEvents(), toolCompletedEvent()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({
      title_text: "hello projection",
      diff: { additions: 3, modifications: 1, deletions: 1 },
    })
  })

  test("projects thread files from tool call input and rebuilds them from the event log", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [...projectionEvents(), toolRequestedEvent()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        const applied = yield* ThreadProjection.listThreadFiles({ thread_id: threadId })
        yield* ThreadProjection.clear()
        const cleared = yield* ThreadProjection.listThreadFiles({ thread_id: threadId })
        yield* ThreadProjection.rebuild()
        const rebuilt = yield* ThreadProjection.listThreadFiles({ thread_id: threadId })
        return { applied, cleared, rebuilt }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.applied.map((file) => file.path)).toEqual(["packages/server/src/search.ts"])
    expect(result.cleared).toEqual([])
    expect(result.rebuilt).toEqual(result.applied)
  })

  test("projects latest context tokens and model attribution", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of contextUsageEvents()) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({
      thread_id: threadId,
      context_tokens: 42_000,
      last_model: "gpt-5.5",
      active_turn_status: "completed",
    })
  })

  test("does not regress projections when an older duplicate event is reapplied", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const events = projectionEvents()
        for (const event of events) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }

        const duplicateStarted = yield* ThreadEventLog.append(events[1])
        yield* ThreadProjection.apply(duplicateStarted)

        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({ active_turn_status: "completed" })
  })

  test("keeps the first terminal turn status when a later terminal event arrives", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [projectionEvents()[0], projectionEvents()[1], turnFailedEvent(), projectionEvents()[3]]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        const applied = yield* ThreadProjection.getThread(threadId)
        yield* ThreadProjection.clear()
        yield* ThreadProjection.rebuild()
        const rebuilt = yield* ThreadProjection.getThread(threadId)
        return { applied, rebuilt }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.applied).toMatchObject({
      active_turn_id: turnId,
      active_turn_status: "failed",
    })
    expect(result.rebuilt).toMatchObject({
      active_turn_id: turnId,
      active_turn_status: "failed",
    })
  })

  test("ignores a late terminal event for an older turn after a newer turn starts", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [
          projectionEvents()[0],
          projectionEvents()[1],
          turnFailedEvent(),
          secondTurnStartedEvent(),
          lateFirstTurnCompletedEvent(),
        ]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        const applied = yield* ThreadProjection.getThread(threadId)
        yield* ThreadProjection.clear()
        yield* ThreadProjection.rebuild()
        const rebuilt = yield* ThreadProjection.getThread(threadId)
        return { applied, rebuilt }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.applied).toMatchObject({
      active_turn_id: secondTurnId,
      active_turn_status: "active",
    })
    expect(result.applied?.context_tokens).toBeUndefined()
    expect(result.applied?.last_model).toBeUndefined()
    expect(result.rebuilt).toMatchObject({
      active_turn_id: secondTurnId,
      active_turn_status: "active",
    })
    expect(result.rebuilt?.context_tokens).toBeUndefined()
    expect(result.rebuilt?.last_model).toBeUndefined()
  })
})

const projectionEvents = (): readonly [
  Event.ThreadCreated,
  Event.TurnStarted,
  Event.MessageAdded,
  Event.TurnCompleted,
] => [
  {
    id: Ids.EventId.make("projection_created"),
    thread_id: threadId,
    sequence: 1,
    version: 1,
    created_at: 1,
    type: "thread.created",
    data: { workspace_id: workspaceId },
  },
  {
    id: Ids.EventId.make("projection_turn_started"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 2,
    version: 1,
    created_at: 2,
    type: "turn.started",
    data: { user_id: userId },
  },
  {
    id: Ids.EventId.make("projection_message"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 3,
    version: 1,
    created_at: 3,
    type: "message.added",
    data: {
      message: Message.user({
        id: Ids.MessageId.make("projection_message"),
        thread_id: threadId,
        turn_id: turnId,
        content: "hello projection",
        created_at: 3,
        metadata: { user_id: userId },
      }),
    },
  },
  {
    id: Ids.EventId.make("projection_turn_completed"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 4,
    version: 1,
    created_at: 4,
    type: "turn.completed",
    data: {},
  },
]

const archivedEvent = (): Event.ThreadArchived => ({
  id: Ids.EventId.make("projection_thread_archived"),
  thread_id: threadId,
  sequence: 5,
  version: 1,
  created_at: 5,
  type: "thread.archived",
  data: {},
})

const unarchivedEvent = (): Event.ThreadUnarchived => ({
  id: Ids.EventId.make("projection_thread_unarchived"),
  thread_id: threadId,
  sequence: 6,
  version: 1,
  created_at: 6,
  type: "thread.unarchived",
  data: {},
})

const visibilitySetEvent = (): Event.Event =>
  ({
    id: Ids.EventId.make("projection_thread_visibility_set"),
    thread_id: threadId,
    sequence: 5,
    version: 1,
    created_at: 5,
    type: "thread.visibility.set",
    data: { visibility: "workspace" },
  }) as Event.Event

const turnFailedEvent = (): Event.TurnFailed => ({
  id: Ids.EventId.make("projection_turn_failed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 3,
  version: 1,
  created_at: 3,
  type: "turn.failed",
  data: { error: { kind: "unknown", message: "turn interrupted by backend restart" } },
})

const secondTurnStartedEvent = (): Event.TurnStarted => ({
  id: Ids.EventId.make("projection_second_turn_started"),
  thread_id: threadId,
  turn_id: secondTurnId,
  sequence: 4,
  version: 1,
  created_at: 4,
  type: "turn.started",
  data: {},
})

const lateFirstTurnCompletedEvent = (): Event.TurnCompleted => ({
  id: Ids.EventId.make("projection_late_first_turn_completed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 5,
  version: 1,
  created_at: 5,
  type: "turn.completed",
  data: { model: "gpt-late", usage: { input_tokens: 99, output_tokens: 1, total_tokens: 100 } },
})

const toolCompletedEvent = (): Event.ToolCallCompleted => ({
  id: Ids.EventId.make("projection_tool_completed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 5,
  version: 1,
  created_at: 5,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make("projection_tool"),
      name: "edit",
      status: "success",
      output: pierreDiff(),
    },
  },
})

const toolRequestedEvent = (): Event.ToolCallRequested => ({
  id: Ids.EventId.make("projection_tool_requested"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 5,
  version: 1,
  created_at: 5,
  type: "tool.call.requested",
  data: {
    call: {
      id: Ids.ToolCallId.make("projection_tool_requested"),
      name: "edit",
      input: { path: "packages/server/src/search.ts", replacement: "ok" },
    },
  },
})

const contextUsageEvents = (): readonly [
  Event.ThreadCreated,
  Event.TurnStarted,
  Event.ModelStreamChunk,
  Event.TurnCompleted,
] => [
  {
    id: Ids.EventId.make("projection_context_created"),
    thread_id: threadId,
    sequence: 1,
    version: 1,
    created_at: 1,
    type: "thread.created",
    data: { workspace_id: workspaceId },
  },
  {
    id: Ids.EventId.make("projection_context_turn_started"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 2,
    version: 1,
    created_at: 2,
    type: "turn.started",
    data: {},
  },
  {
    id: Ids.EventId.make("projection_context_model"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 3,
    version: 1,
    created_at: 3,
    type: "model.stream.chunk",
    data: { provider: "openai", model: "gpt-5.5", text: "answer" },
  },
  {
    id: Ids.EventId.make("projection_context_turn_completed"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 4,
    version: 1,
    created_at: 4,
    type: "turn.completed",
    data: { usage: { input_tokens: 42_000, output_tokens: 200, total_tokens: 42_200 } },
  },
]

const pierreDiff = (): Common.JsonValue => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  collapsed: true,
  file_diff: {
    name: "packages/tui/src/adapter.ts",
    hunks: [
      {
        hunkContent: [
          {
            type: "change",
            additions: 3,
            deletions: 1,
          },
        ],
      },
    ],
  },
})
