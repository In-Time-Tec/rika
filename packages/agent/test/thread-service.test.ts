import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Database, Migration, ProjectStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Artifact, Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { ThreadService } from "../src/index"

const threadId = Ids.ThreadId.make("thread_service")
const workspaceId = Ids.WorkspaceId.make("workspace_thread_service")
const userId = Ids.UserId.make("user_thread_service")
const turnId = Ids.TurnId.make("turn_thread_service")
const turnOneId = Ids.TurnId.make("turn_thread_service_one")
const turnTwoId = Ids.TurnId.make("turn_thread_service_two")
const activeTurnId = Ids.TurnId.make("turn_thread_service_active")
const artifactId = Ids.ArtifactId.make("artifact_thread_service")
const now = Common.TimestampMillis.make(1_960_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-thread-service-test",
  data_dir: "/workspace/rika-thread-service-test/.rika",
  default_mode: "smart",
})
const databaseLayer = Database.memoryLayer
const timeLayer = Time.fixedLayer(now)
const idLayer = IdGenerator.sequenceLayer(1)
const redactorLayer = SecretRedactor.layer
const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
const projectStoreLayer = ProjectStore.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(timeLayer),
  Layer.provideMerge(idLayer),
)

const services = Layer.mergeAll(
  configLayer,
  databaseLayer,
  Migration.layer,
  projectStoreLayer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  timeLayer,
  idLayer,
  redactorLayer,
  diagnosticsLayer,
)

const layer = ThreadService.layer.pipe(Layer.provideMerge(services), Layer.provideMerge(diagnosticsLayer))

describe("ThreadService", () => {
  test("creates, opens, archives, lists, and unarchives local threads", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        const opened = yield* ThreadService.open({ thread_id: threadId })
        const archived = yield* ThreadService.archive({ thread_id: threadId })
        const active = yield* ThreadService.list({})
        const all = yield* ThreadService.list({ include_archived: true })
        const unarchived = yield* ThreadService.unarchive({ thread_id: threadId })
        const activeAgain = yield* ThreadService.list({})
        return { created, opened, archived, active, all, unarchived, activeAgain }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, archived: false })
    expect(result.opened.events.map((event) => event.type)).toEqual(["thread.created"])
    expect(result.archived.archived).toBe(true)
    expect(result.active).toEqual([])
    expect(result.all.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(result.unarchived.archived).toBe(false)
    expect(result.activeAgain.map((summary) => summary.thread_id)).toEqual([threadId])
  })

  test("sets thread visibility through an append-only event", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId, user_id: userId })
        const visible = yield* ThreadService.setVisibility({ thread_id: threadId, visibility: "workspace" })
        const unchanged = yield* ThreadService.setVisibility({ thread_id: threadId, visibility: "workspace" })
        const record = yield* ThreadService.open({ thread_id: threadId })
        yield* ThreadProjection.clear()
        yield* ThreadProjection.rebuild()
        const rebuilt = yield* ThreadService.open({ thread_id: threadId })
        return { created, visible, unchanged, record, rebuilt }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.created.visibility).toBe("private")
    expect(result.visible.visibility).toBe("workspace")
    expect(result.unchanged.visibility).toBe("workspace")
    expect(result.record.events.map((event) => event.type)).toEqual(["thread.created", "thread.visibility.set"])
    expect(result.rebuilt.summary).toEqual(result.record.summary)
  })

  test("searches, exports, and renders compact thread references", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        const message = messageAdded()
        const appended = yield* ThreadEventLog.append(message)
        yield* ThreadProjection.apply(appended)

        const search = yield* ThreadService.search({ query: "auth race" })
        const exported = yield* ThreadService.share({ thread_id: threadId })
        const reference = yield* ThreadService.reference({ thread_id: threadId, query: "auth" })
        return { search, exported, reference }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.search).toHaveLength(1)
    expect(result.search[0]?.summary.thread_id).toBe(threadId)
    expect(result.search[0]?.matched.join("\n")).toContain("Fix auth race")
    expect(result.exported).toMatchObject({ schema_version: 1, thread_id: threadId })
    expect(result.exported.events.map((event) => event.type)).toEqual(["thread.created", "message.added"])
    expect(result.reference.rendered).toContain(`Thread ${threadId}`)
    expect(result.reference.rendered).toContain("Fix auth race")
    expect(result.reference.entries).toContain("File: src/auth.ts")
  })

  test("restricts search scoring to explicit thread candidates", async () => {
    const hiddenThreadId = Ids.ThreadId.make("thread_service_search_hidden")
    const visibleThreadId = Ids.ThreadId.make("thread_service_search_visible")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendProjected(threadCreatedForThread(hiddenThreadId, "hidden"))
        yield* appendProjected(
          messageAddedForThread(2, turnId, "thread_service_hidden_message", "hidden needle", hiddenThreadId),
        )
        yield* appendProjected(threadCreatedForThread(visibleThreadId, "visible"))
        yield* appendProjected(
          messageAddedForThread(2, turnId, "thread_service_visible_message", "visible hay", visibleThreadId),
        )
        const candidateSearch = yield* ThreadService.search({ query: "needle", thread_ids: [visibleThreadId] })
        const fullSearch = yield* ThreadService.search({ query: "needle" })
        return { candidateSearch, fullSearch }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.candidateSearch).toEqual([])
    expect(result.fullSearch.map((item) => item.summary.thread_id)).toEqual([hiddenThreadId])
  })

  test("search consumes file, archived, project, and relative time filters from the query string", async () => {
    const activeThreadId = Ids.ThreadId.make("thread_service_search_active")
    const archivedThreadId = Ids.ThreadId.make("thread_service_search_archived")
    const staleThreadId = Ids.ThreadId.make("thread_service_search_stale")
    const otherWorkspaceThreadId = Ids.ThreadId.make("thread_service_search_other_workspace")
    const recent = Common.TimestampMillis.make(now - 86_400_000)
    const stale = Common.TimestampMillis.make(now - 10 * 86_400_000)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const project = yield* ProjectStore.create({
          name: "backend",
          repo_origin: "https://github.com/example/backend.git",
        })
        const projectWorkspaceId = Ids.WorkspaceId.make(`project:${project.project_id}`)
        for (const event of [
          searchThreadCreated(activeThreadId, projectWorkspaceId, recent, "active"),
          toolRequestedForThread(activeThreadId, 2, recent, "packages/server/src/search.ts", "active"),
          searchMessageAdded(activeThreadId, 3, recent, "needle active", "active"),
          searchThreadCreated(archivedThreadId, projectWorkspaceId, recent, "archived"),
          toolRequestedForThread(archivedThreadId, 2, recent, "packages/server/src/search.ts", "archived"),
          searchMessageAdded(archivedThreadId, 3, recent, "needle archived", "archived"),
          threadArchivedForThread(archivedThreadId, 4, recent, "archived"),
          searchThreadCreated(staleThreadId, projectWorkspaceId, stale, "stale"),
          toolRequestedForThread(staleThreadId, 2, stale, "packages/server/src/search.ts", "stale"),
          searchMessageAdded(staleThreadId, 3, stale, "needle stale", "stale"),
          searchThreadCreated(otherWorkspaceThreadId, workspaceId, recent, "other"),
          toolRequestedForThread(otherWorkspaceThreadId, 2, recent, "packages/server/src/search.ts", "other"),
          searchMessageAdded(otherWorkspaceThreadId, 3, recent, "needle other", "other"),
        ]) {
          yield* appendProjected(event)
        }

        const filtered = yield* ThreadService.search({
          query: "needle file:packages/server/**/*.ts archived:false after:7d project:backend",
        })
        const archived = yield* ThreadService.search({
          query: "needle archived:true",
          include_archived: false,
        })
        return { filtered, archived }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.filtered.map((item) => item.summary.thread_id)).toEqual([activeThreadId])
    expect(result.archived.map((item) => item.summary.thread_id)).toEqual([archivedThreadId])
  })

  test("enriches stored context usage with model context window", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        for (const event of [modelChunk(), turnCompletedWithUsage()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        const summaries = yield* ThreadService.list({})
        return summaries[0]
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({
      thread_id: threadId,
      context_tokens: 42_000,
      context_window: 400_000,
    })
  })

  test("loads preview records from the latest event-log tail", async () => {
    const preview = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        for (const event of [messageAdded(2, "first"), messageAdded(3, "second"), messageAdded(4, "third")]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadService.preview({ thread_id: threadId, limit: 2 })
      }).pipe(Effect.provide(layer)),
    )

    expect(preview.summary.title_text).toBe("first")
    expect(preview.summary.latest_message_text).toBe("third")
    expect(preview.events.map((event) => event.sequence)).toEqual([3, 4])
  })

  test("forks a thread at a completed turn boundary with a faithful event prefix", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const sourceEvents = forkSourceEvents()
        for (const event of sourceEvents) {
          yield* appendProjected(event)
        }
        const forked = yield* ThreadService.fork({ thread_id: threadId, at_turn: turnOneId, user_id: userId })
        const record = yield* ThreadService.open({ thread_id: forked.thread_id })
        yield* ThreadProjection.clear()
        yield* ThreadProjection.rebuild()
        const rebuilt = yield* ThreadService.open({ thread_id: forked.thread_id })
        return { sourceEvents, forked, record, rebuilt }
      }).pipe(Effect.provide(layer)),
    )

    const copiedSource = result.sourceEvents.slice(0, 5)
    const forkEvents = result.record.events
    const created = forkEvents.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    const message = forkEvents.find((event): event is Event.MessageAdded => event.type === "message.added")
    const artifact = forkEvents.find((event): event is Event.ArtifactCreated => event.type === "artifact.created")

    expect(forkEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(forkEvents.every((event) => event.thread_id === result.forked.thread_id)).toBe(true)
    expect(forkEvents.map((event) => event.id)).not.toEqual(copiedSource.map((event) => event.id))
    expect(created?.data).toEqual({
      workspace_id: workspaceId,
      user_id: userId,
      forked_from: { thread_id: threadId, sequence: 5 },
    })
    expect(message?.data.message.id).toBe(Ids.MessageId.make("thread_service_message_one"))
    expect(message?.data.message.thread_id).toBe(result.forked.thread_id)
    expect(message?.data.message.turn_id).toBe(turnOneId)
    expect(artifact?.data.artifact.id).toBe(artifactId)
    expect(artifact?.data.artifact.thread_id).toBe(threadId)
    expect(result.forked).toMatchObject({
      thread_id: result.forked.thread_id,
      workspace_id: workspaceId,
      user_id: userId,
      title_text: "first turn",
      latest_message_text: "first turn",
      active_turn_id: turnOneId,
      active_turn_status: "completed",
      context_tokens: 10,
    })
    expect(result.rebuilt.summary).toEqual(result.record.summary)
  })

  test("forks a fork from the immediate parent history", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of forkSourceEvents().slice(0, 5)) {
          yield* appendProjected(event)
        }
        const firstFork = yield* ThreadService.fork({ thread_id: threadId })
        const secondFork = yield* ThreadService.fork({ thread_id: firstFork.thread_id })
        const record = yield* ThreadService.open({ thread_id: secondFork.thread_id })
        return { firstFork, secondFork, record }
      }).pipe(Effect.provide(layer)),
    )

    const created = result.record.events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    expect(created?.data.forked_from).toEqual({ thread_id: result.firstFork.thread_id, sequence: 5 })
    expect(result.secondFork.latest_message_text).toBe("first turn")
  })

  test("forks start private even when the source thread was shared", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendProjected(threadCreated())
        yield* appendProjected(threadVisibilitySet(2, "unlisted"))
        yield* appendProjected(messageAdded(3, "fork stays private"))
        const forked = yield* ThreadService.fork({ thread_id: threadId })
        const record = yield* ThreadService.open({ thread_id: forked.thread_id })
        return { forked, record }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.forked.visibility).toBe("private")
    expect(result.forked.latest_message_text).toBe("fork stays private")
    expect(result.record.events.map((event) => event.type)).toEqual(["thread.created", "message.added"])
    expect(result.record.events.map((event) => event.sequence)).toEqual([1, 2])
  })

  test("seeds a fork title from durable thread-created data", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of forkSourceEvents().slice(0, 5)) {
          yield* appendProjected(event)
        }
        const forked = yield* ThreadService.fork({
          thread_id: threadId,
          title_text: "tournament:source/1",
        })
        const record = yield* ThreadService.open({ thread_id: forked.thread_id })
        return { forked, record }
      }).pipe(Effect.provide(layer)),
    )

    const created = result.record.events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    expect(created?.data.title_text).toBe("tournament:source/1")
    expect(result.forked.title_text).toBe("tournament:source/1")
    expect(result.record.summary.title_text).toBe("tournament:source/1")
  })

  test("rejects forks that would copy an open turn", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of openTurnEvents()) {
          yield* appendProjected(event)
        }
        const endError = yield* ThreadService.fork({ thread_id: threadId }).pipe(Effect.flip)
        const turnError = yield* ThreadService.fork({ thread_id: threadId, at_turn: activeTurnId }).pipe(Effect.flip)
        return { endError, turnError }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.endError).toBeInstanceOf(ThreadService.ThreadForkError)
    expect(result.endError instanceof ThreadService.ThreadForkError ? result.endError.reason : undefined).toBe(
      "turn_open",
    )
    expect(result.turnError).toBeInstanceOf(ThreadService.ThreadForkError)
    expect(result.turnError instanceof ThreadService.ThreadForkError ? result.turnError.reason : undefined).toBe(
      "turn_open",
    )
  })
})

const appendProjected = (event: Event.Event) =>
  Effect.gen(function* () {
    const appended = yield* ThreadEventLog.append(event)
    yield* ThreadProjection.apply(appended)
    return appended
  })

const forkSourceEvents = (): ReadonlyArray<Event.Event> => [
  threadCreated(),
  turnStarted(2, turnOneId),
  messageAddedForThread(3, turnOneId, "thread_service_message_one", "first turn"),
  artifactCreated(4, turnOneId),
  turnCompleted(5, turnOneId, 10),
  turnStarted(6, turnTwoId),
  messageAddedForThread(7, turnTwoId, "thread_service_message_two", "second turn"),
  turnCompleted(8, turnTwoId, 20),
]

const openTurnEvents = (): ReadonlyArray<Event.Event> => [threadCreated(), turnStarted(2, activeTurnId)]

const threadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("thread_service_event_created"),
  thread_id: threadId,
  sequence: 1,
  version: 1,
  created_at: Common.TimestampMillis.make(now - 10),
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const threadCreatedForThread = (createdThreadId: Ids.ThreadId, suffix: string): Event.ThreadCreated => ({
  id: Ids.EventId.make(`thread_service_event_created_${suffix}`),
  thread_id: createdThreadId,
  sequence: 1,
  version: 1,
  created_at: Common.TimestampMillis.make(now - 10),
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const threadVisibilitySet = (sequence: number, visibility: Event.ThreadVisibility): Event.ThreadVisibilitySet => ({
  id: Ids.EventId.make(`thread_service_event_visibility_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(now + sequence),
  type: "thread.visibility.set",
  data: { visibility },
})

const turnStarted = (sequence: number, startedTurnId: Ids.TurnId): Event.TurnStarted => ({
  id: Ids.EventId.make(`thread_service_event_turn_started_${sequence}`),
  thread_id: threadId,
  turn_id: startedTurnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(now + sequence),
  type: "turn.started",
  data: {},
})

const messageAddedForThread = (
  sequence: number,
  messageTurnId: Ids.TurnId,
  messageIdValue: string,
  content: string,
  messageThreadId: Ids.ThreadId = threadId,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`thread_service_event_message_${messageIdValue}_${sequence}`),
  thread_id: messageThreadId,
  turn_id: messageTurnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(now + sequence),
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(messageIdValue),
      thread_id: messageThreadId,
      turn_id: messageTurnId,
      created_at: Common.TimestampMillis.make(now + sequence),
      content,
    }),
  },
})

const artifactCreated = (sequence: number, artifactTurnId: Ids.TurnId): Event.ArtifactCreated => ({
  id: Ids.EventId.make(`thread_service_event_artifact_${sequence}`),
  thread_id: threadId,
  turn_id: artifactTurnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(now + sequence),
  type: "artifact.created",
  data: {
    artifact: {
      id: artifactId,
      thread_id: threadId,
      turn_id: artifactTurnId,
      kind: "research" satisfies Artifact.Kind,
      title: "Research note",
      content: { source: "source thread" },
      created_at: Common.TimestampMillis.make(now + sequence),
    },
  },
})

const turnCompleted = (sequence: number, completedTurnId: Ids.TurnId, inputTokens: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`thread_service_event_turn_completed_${sequence}`),
  thread_id: threadId,
  turn_id: completedTurnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(now + sequence),
  type: "turn.completed",
  data: { model: "gpt-5.5", usage: { input_tokens: inputTokens } },
})

const modelChunk = (): Event.ModelStreamChunk => ({
  id: Ids.EventId.make("thread_service_model_chunk"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "model.stream.chunk",
  data: { provider: "openai", model: "gpt-5.5", text: "answer" },
})

const turnCompletedWithUsage = (): Event.TurnCompleted => ({
  id: Ids.EventId.make("thread_service_turn_completed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 3,
  version: 1,
  created_at: now,
  type: "turn.completed",
  data: { usage: { input_tokens: 42_000, output_tokens: 100, total_tokens: 42_100 } },
})

const messageAdded = (
  sequence = 2,
  content: string | ReadonlyArray<Message.ContentPart> = [
    Message.text("Fix auth race"),
    { type: "file-reference", path: "src/auth.ts" },
  ],
): Event.MessageAdded => ({
  id: Ids.EventId.make(`thread_service_message_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`thread_service_message_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      created_at: now,
      content,
    }),
  },
})

const searchThreadCreated = (
  searchThreadId: Ids.ThreadId,
  searchWorkspaceId: Ids.WorkspaceId,
  createdAt: Common.TimestampMillis,
  suffix: string,
): Event.ThreadCreated => ({
  id: Ids.EventId.make(`thread_service_search_created_${suffix}`),
  thread_id: searchThreadId,
  sequence: 1,
  version: 1,
  created_at: createdAt,
  type: "thread.created",
  data: { workspace_id: searchWorkspaceId },
})

const searchMessageAdded = (
  searchThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  content: string,
  suffix: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`thread_service_search_message_${suffix}`),
  thread_id: searchThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`thread_service_search_message_${suffix}`),
      thread_id: searchThreadId,
      turn_id: turnId,
      created_at: createdAt,
      content,
    }),
  },
})

const toolRequestedForThread = (
  searchThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  path: string,
  suffix: string,
): Event.ToolCallRequested => ({
  id: Ids.EventId.make(`thread_service_search_tool_${suffix}`),
  thread_id: searchThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "tool.call.requested",
  data: {
    call: {
      id: Ids.ToolCallId.make(`thread_service_search_tool_${suffix}`),
      name: "edit",
      input: { path, replacement: "ok" },
    },
  },
})

const threadArchivedForThread = (
  searchThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  suffix: string,
): Event.ThreadArchived => ({
  id: Ids.EventId.make(`thread_service_search_archived_${suffix}`),
  thread_id: searchThreadId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "thread.archived",
  data: {},
})
