import { describe, expect, test } from "bun:test"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message, Remote } from "@rika/schema"
import { Effect, Queue, Stream } from "effect"
import { Adapter, Keys, RemoteSession, Ticker, ViewState } from "../src/index"

const workspaceRoot = "/workspace/rika-remote-tui-test"
const workspaceId = Ids.WorkspaceId.make(workspaceRoot)

const line = (text: string): ReadonlyArray<Keys.Key> => [...Keys.fromString(text), Keys.enter]

const text = (rendered: ReadonlyArray<ViewState.ViewState>): string =>
  rendered
    .map((state) => [state.notice ?? "", state.messages.map((message) => message.text).join("\n")].join("\n"))
    .join("\n")

describe("TUI remote session", () => {
  test("runs as a thin client over the shared backend SDK", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []
    const keys = [
      "hello",
      "/welcome",
      "/threads",
      "/new",
      "/thread thread_remote_initial",
      "/archive",
      "/unarchive",
      "/version",
      "/credits",
      "/ast-grep outline status",
      "/debug all",
      "/debug thread",
      "/mcp authenticate",
      "/mcp info",
      "/exit",
    ].flatMap(line)

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart" }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered, keys })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("remote response")
    expect(frames).toContain("Active threads")
    expect(frames).toContain("Started new thread")
    expect(rendered.some((state) => state.connecting_ticks > 0)).toBe(true)
    expect(frames).toContain("Archived thread_remote_initial")
    expect(frames).toContain("Unarchived thread_remote_initial")
    expect(frames).toContain("Rika 0.0.0")
    expect(frames).toContain("Rika is Amp-compatible software.")
    expect(frames).toContain("ast-grep outline status: ready")
    expect(frames).toContain("Opening motel for all Rika telemetry.")
    expect(frames).toContain("Opening motel for thread")
    expect(frames).toContain("MCP authentication requested.")
    expect(frames).toContain("No MCP servers connected.")
    expect(frames).not.toContain("Unknown command /welcome")
    expect(backend.turns).toEqual(["hello"])
  })

  test("relaunch exits after recording a relaunch notice", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart" }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered, keys: line("/relaunch") })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Relaunch requested. Start Rika again after this session exits.")
    expect(backend.turns).toEqual([])
  })

  test("file UI actions open through the renderer", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []
    const opened: Array<Adapter.OpenFileInput> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart" }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(
          Adapter.memoryLayer({
            rendered,
            keys: line("/exit"),
            opened,
            actions: [
              {
                _tag: "OpenFile",
                path: "packages/tui/src/adapter.ts",
                range: { start_line: 4, end_line: 4 },
              },
            ],
          }),
        ),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(opened).toEqual([
      {
        workspace_path: workspaceRoot,
        path: "packages/tui/src/adapter.ts",
        range: { start_line: 4, end_line: 4 },
      },
    ])
  })
})

interface FakeBackend {
  readonly client: Client.Interface
  readonly turns: Array<string>
}

const fakeBackend = (): FakeBackend => {
  const turns: Array<string> = []
  const threads = new Map<Ids.ThreadId, { summary: Remote.ThreadSummary; events: Array<Event.Event> }>()
  const subscribers = new Set<(event: Event.Event) => void>()
  const initialThread = Ids.ThreadId.make("thread_remote_initial")
  const initialEvents = [threadCreated(initialThread, 1), messageAdded(initialThread, 2, "old remote message")]
  threads.set(initialThread, { summary: summary(initialThread, "old remote message"), events: [...initialEvents] })
  let nextThread = 1

  const client: Client.Interface = {
    backendHealth: () =>
      Effect.succeed({
        status: "healthy",
        url: "http://127.0.0.1:4587",
        workspace_root: workspaceRoot,
        data_dir: `${workspaceRoot}/.rika`,
        backend_id: "test-backend",
        pid: 123,
        version: "0.0.0",
      }),
    createThread: (input: Remote.CreateThreadRequest = {}) =>
      Effect.sync(() => {
        const threadId = input.thread_id ?? Ids.ThreadId.make(`thread_remote_created_${nextThread++}`)
        const threadSummary = summary(threadId)
        threads.set(threadId, { summary: threadSummary, events: [threadCreated(threadId, 1)] })
        return threadSummary
      }),
    listThreads: () => Effect.sync(() => [...threads.values()].map((record) => record.summary)),
    openThread: (threadId) =>
      Effect.suspend(() => {
        const record = threads.get(threadId)
        if (record === undefined)
          return Effect.fail(new Client.SdkError({ message: "missing", operation: "openThread", status: 404 }))
        return Effect.succeed({ summary: record.summary, events: record.events })
      }),
    previewThread: (threadId) =>
      Effect.suspend(() => {
        const record = threads.get(threadId)
        if (record === undefined)
          return Effect.fail(new Client.SdkError({ message: "missing", operation: "previewThread", status: 404 }))
        return Effect.succeed({ summary: record.summary, events: record.events.slice(-160) })
      }),
    archiveThread: (threadId) => Effect.sync(() => setArchived(threads, threadId, true)),
    unarchiveThread: (threadId) => Effect.sync(() => setArchived(threads, threadId, false)),
    searchThreads: () =>
      Effect.sync(() =>
        [...threads.values()].map((record) => ({
          summary: record.summary,
          score: 1,
          matched: [record.summary.latest_message_text ?? ""],
        })),
      ),
    shareThread: (threadId) =>
      Effect.suspend(() => {
        const record = threads.get(threadId)
        if (record === undefined)
          return Effect.fail(new Client.SdkError({ message: "missing", operation: "shareThread", status: 404 }))
        return Effect.succeed({
          schema_version: 1,
          exported_at: Common.TimestampMillis.make(10),
          thread_id: threadId,
          summary: record.summary,
          events: record.events,
        })
      }),
    referenceThread: (input) =>
      Effect.succeed({
        thread_id: input.thread_id,
        rendered: `Reference for ${input.thread_id}`,
        entries: [],
        total_chars: 0,
        truncated: false,
      }),
    subscribeThreadEvents: (input) =>
      Stream.callback<Event.Event>((queue) =>
        Effect.sync(() => {
          let lastSequence = input.after_sequence ?? 0
          const offer = (event: Event.Event) => {
            if (event.thread_id !== input.thread_id || event.sequence <= lastSequence) return
            lastSequence = event.sequence
            Queue.offerUnsafe(queue, event)
          }
          for (const event of threads.get(input.thread_id)?.events ?? []) offer(event)
          subscribers.add(offer)
        }),
      ),
    startTurn: (input) =>
      Effect.sync(() => {
        turns.push(input.content)
        const events = turnEvents(input.thread_id, input.content, "remote response")
        const record = threads.get(input.thread_id)
        if (record !== undefined) {
          record.events.push(...events)
          record.summary = summary(input.thread_id, "remote response")
        }
        for (const event of events) {
          for (const subscriber of subscribers) subscriber(event)
        }
        return { thread_id: input.thread_id, accepted: true }
      }),
    interruptTurn: (input) => Effect.succeed(turnFailed(input.thread_id, input.turn_id, 1)),
    listArtifacts: () => Effect.succeed([]),
    getArtifact: (artifactId) =>
      Effect.fail(new Client.SdkError({ message: String(artifactId), operation: "getArtifact", status: 404 })),
    connectIde: (input) =>
      Effect.succeed({ client_id: input.client_id, connected: true, capabilities: input.capabilities }),
    disconnectIde: () => Effect.succeed(emptyIdeStatus),
    updateIdeContext: () => Effect.succeed(emptyIdeStatus),
    ideStatus: () => Effect.succeed(emptyIdeStatus),
    openIdeFile: () => Effect.succeed({ accepted: false }),
    ideNavigationRequests: () => Effect.succeed([]),
  }

  return { client, turns }
}

const emptyIdeStatus = { connected: false, capabilities: [], workspace_roots: [] } as const

const setArchived = (
  threads: Map<Ids.ThreadId, { summary: Remote.ThreadSummary; events: Array<Event.Event> }>,
  threadId: Ids.ThreadId,
  archived: boolean,
) => {
  const record = threads.get(threadId)
  if (record === undefined) throw new Error(`Missing thread ${threadId}`)
  record.summary = { ...record.summary, archived }
  return record.summary
}

const summary = (threadId: Ids.ThreadId, latest?: string): Remote.ThreadSummary => ({
  thread_id: threadId,
  workspace_id: workspaceId,
  ...(latest === undefined ? {} : { latest_message_text: latest }),
  ...(latest === undefined ? {} : { title_text: latest }),
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  created_at: Common.TimestampMillis.make(1),
  updated_at: Common.TimestampMillis.make(2),
})

const turnEvents = (threadId: Ids.ThreadId, content: string, response: string): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make("turn_remote_session")
  return [
    turnStarted(threadId, turnId, 3),
    messageAdded(threadId, 4, content, turnId, "user"),
    modelChunk(threadId, turnId, 5, response),
    messageAdded(threadId, 6, response, turnId, "assistant"),
    turnCompleted(threadId, turnId, 7),
  ]
}

const base = (threadId: Ids.ThreadId, sequence: number, turnId?: Ids.TurnId): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_remote_session_${threadId}_${sequence}`),
  thread_id: threadId,
  ...(turnId === undefined ? {} : { turn_id: turnId }),
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const threadCreated = (threadId: Ids.ThreadId, sequence: number): Event.ThreadCreated => ({
  ...base(threadId, sequence),
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const turnStarted = (threadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnStarted => ({
  ...base(threadId, sequence, turnId),
  turn_id: turnId,
  type: "turn.started",
  data: {},
})

const messageAdded = (
  threadId: Ids.ThreadId,
  sequence: number,
  content: string,
  turnId = Ids.TurnId.make("turn_existing_remote_session"),
  role: Message.Role = "user",
): Event.MessageAdded => ({
  ...base(threadId, sequence, turnId),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_remote_session_${threadId}_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(content)],
      created_at: Common.TimestampMillis.make(sequence),
    },
  },
})

const modelChunk = (
  threadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  textValue: string,
): Event.ModelStreamChunk => ({
  ...base(threadId, sequence, turnId),
  turn_id: turnId,
  type: "model.stream.chunk",
  data: { text: textValue, provider: "fake", model: "fake" },
})

const turnCompleted = (threadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnCompleted => ({
  ...base(threadId, sequence, turnId),
  turn_id: turnId,
  type: "turn.completed",
  data: {},
})

const turnFailed = (threadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnFailed => ({
  ...base(threadId, sequence, turnId),
  turn_id: turnId,
  type: "turn.failed",
  data: { error: { kind: "cancelled", message: "cancelled" } },
})
