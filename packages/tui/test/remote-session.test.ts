import { describe, expect, test } from "bun:test"
import { TournamentService } from "@rika/agent"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message, Remote } from "@rika/schema"
import { Effect, Queue, Stream } from "effect"
import { Adapter, Keys, RemoteSession, Ticker, ViewState } from "../src/index"

const workspaceRoot = "/workspace/rika-remote-tui-test"
const workspaceId = Ids.WorkspaceId.make(workspaceRoot)
const initialThreadId = Ids.ThreadId.make("thread_remote_initial")
const initialOrbId = Ids.OrbId.make("orb_remote_initial")

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
    expect(frames).toContain("[orb:running]")
    expect(frames).toContain("Started new thread")
    expect(rendered.some((state) => state.connecting_ticks > 0)).toBe(true)
    expect(frames).toContain("Archived thread_remote_initial")
    expect(frames).toContain("Unarchived thread_remote_initial")
    expect(frames).toContain("Rika 0.0.0")
    expect(frames).toContain("Rika is Amp-compatible software.")
    expect(frames).toContain("ast-grep outline status: ready")
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

  test("mode slash command switches only before remote thread activity", async () => {
    const idleBackend = fakeBackend()
    const idleRendered: Array<ViewState.ViewState> = []
    const activeBackend = fakeBackend()
    const activeRendered: Array<ViewState.ViewState> = []

    const idleExitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart" }).pipe(
        Effect.provide(RemoteSession.layerFromClient(idleBackend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered: idleRendered, keys: ["/mode rush", "/exit"].flatMap(line) })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )
    const activeExitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart", thread_id: initialThreadId }).pipe(
        Effect.provide(RemoteSession.layerFromClient(activeBackend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered: activeRendered, keys: ["/mode rush", "/exit"].flatMap(line) })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(idleExitCode).toBe(0)
    expect(activeExitCode).toBe(0)
    expect(idleRendered.some((state) => state.mode === "rush")).toBe(true)
    expect(activeRendered.some((state) => state.notice === "Mode is locked once a thread is active.")).toBe(true)
    expect(activeRendered.some((state) => state.mode === "rush")).toBe(false)
  })

  test("remote welcome cannot unlock mode after completed activity", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart", thread_id: initialThreadId }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered, keys: ["/welcome", "/mode rush", "/exit"].flatMap(line) })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(rendered.some((state) => state.notice === "Mode is locked once a thread is active.")).toBe(true)
    expect(rendered.some((state) => state.mode === "rush")).toBe(false)
  })

  test("reports invalid remote thread visibility commands as usage", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart" }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(
          Adapter.memoryLayer({
            rendered,
            keys: ["/thread visibility group", "/thread visibility", "/exit"].flatMap(line),
          }),
        ),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Usage: /thread visibility <private|workspace|unlisted>")
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

  test("uses the runtime-supplied workspace identity for remote SDK calls", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []
    const projectWorkspaceId = Ids.WorkspaceId.make("project:project_remote_session")

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* Adapter.Service
        const ticker = yield* Ticker.Service
        return yield* RemoteSession.make(backend.client, renderer, ticker.ticks, projectWorkspaceId).run({
          workspace_root: workspaceRoot,
          mode: "smart",
        })
      }).pipe(
        Effect.provide(Adapter.memoryLayer({ rendered, keys: ["hello", "/threads", "/new", "/exit"].flatMap(line) })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(backend.workspaceIds).toEqual([
      projectWorkspaceId,
      projectWorkspaceId,
      projectWorkspaceId,
      projectWorkspaceId,
    ])
  })

  test("uses the orb-created project workspace identity for later turns", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []
    const projectWorkspaceId = Ids.WorkspaceId.make("project:project_demo")

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart" }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(
          Adapter.memoryLayer({
            rendered,
            keys: ["/project select demo", "/orb toggle", "/new", "after orb", "/exit"].flatMap(line),
          }),
        ),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(backend.turns).toEqual(["after orb"])
    expect(backend.workspaceIds.at(-1)).toBe(projectWorkspaceId)
    expect(rendered.some((state) => state.remoteArm.enabled)).toBe(true)
    expect(rendered.at(-1)?.remoteArm.enabled).toBe(false)
  })

  test("runs orb lifecycle commands against the active orb-backed thread", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart", thread_id: initialThreadId }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(
          Adapter.memoryLayer({
            rendered,
            keys: ["/orb pause", "/orb resume", "/orb kill", "/exit"].flatMap(line),
          }),
        ),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(backend.orbActions).toEqual([`pause:${initialOrbId}`, `resume:${initialOrbId}`, `kill:${initialOrbId}`])
    expect(frames).toContain("Orb paused.")
    expect(frames).toContain("Orb resumed.")
    expect(frames).toContain("Orb killed.")
    expect(rendered.at(-1)?.active_orb?.status).toBe("killed")
  })

  test("runs manual compaction against the active remote thread", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart", thread_id: initialThreadId }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered, keys: ["/compact", "/exit"].flatMap(line) })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(backend.compactions).toEqual([initialThreadId])
    expect(text(rendered)).toContain("Compacted thread context.")
    expect(rendered.at(-1)?.cards).toContainEqual(
      expect.objectContaining({ title: "Context compacted", subtitle: "manual" }),
    )
  })

  test("runs tournament through the runtime-supplied remote runner", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []
    const calls: Array<{ readonly thread_id: Ids.ThreadId; readonly message: string; readonly branch_count: number }> =
      []

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* Adapter.Service
        const ticker = yield* Ticker.Service
        return yield* RemoteSession.make(backend.client, renderer, ticker.ticks, workspaceId, (input) =>
          Effect.sync(() => {
            calls.push(input)
            return tournamentResult(input.thread_id, input.message)
          }),
        ).run({
          workspace_root: workspaceRoot,
          mode: "smart",
          thread_id: initialThreadId,
        })
      }).pipe(
        Effect.provide(
          Adapter.memoryLayer({ rendered, keys: ["/tournament -n 2 compare answers", "/exit"].flatMap(line) }),
        ),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    expect(exitCode).toBe(0)
    expect(calls).toEqual([{ thread_id: initialThreadId, message: "compare answers", branch_count: 2 }])
    expect(text(rendered)).toContain("Tournament winner: thread_remote_tournament_winner")
  })

  test("forks the active remote thread and opens the fork", async () => {
    const backend = fakeBackend()
    const rendered: Array<ViewState.ViewState> = []

    const exitCode = await Effect.runPromise(
      RemoteSession.run({ workspace_root: workspaceRoot, mode: "smart", thread_id: initialThreadId }).pipe(
        Effect.provide(RemoteSession.layerFromClient(backend.client)),
        Effect.provide(Adapter.memoryLayer({ rendered, keys: ["/fork", "/exit"].flatMap(line) })),
        Effect.provide(Ticker.memoryLayer),
      ),
    )

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(backend.forks).toEqual([initialThreadId])
    expect(frames).toContain("Forked thread")
    expect(rendered.at(-1)?.thread_id).not.toBe(initialThreadId)
  })
})

interface FakeBackend {
  readonly client: Client.Interface
  readonly turns: Array<string>
  readonly workspaceIds: Array<Ids.WorkspaceId | undefined>
  readonly orbActions: Array<string>
  readonly compactions: Array<Ids.ThreadId>
  readonly forks: Array<Ids.ThreadId>
}

const fakeBackend = (): FakeBackend => {
  const turns: Array<string> = []
  const workspaceIds: Array<Ids.WorkspaceId | undefined> = []
  const orbActions: Array<string> = []
  const compactions: Array<Ids.ThreadId> = []
  const forks: Array<Ids.ThreadId> = []
  const threads = new Map<Ids.ThreadId, { summary: Remote.ThreadSummary; events: Array<Event.Event> }>()
  const subscribers = new Set<(event: Event.Event) => void>()
  const orbs = new Map<Ids.ThreadId, Remote.OrbSummary>()
  const initialEvents = [threadCreated(initialThreadId, 1), messageAdded(initialThreadId, 2, "old remote message")]
  threads.set(initialThreadId, { summary: summary(initialThreadId, "old remote message"), events: [...initialEvents] })
  orbs.set(initialThreadId, orbSummary(initialThreadId, initialOrbId, "running"))
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
        workspaceIds.push(input.workspace_id)
        const threadId = input.thread_id ?? Ids.ThreadId.make(`thread_remote_created_${nextThread++}`)
        const threadSummary = summary(threadId, undefined, input.workspace_id)
        threads.set(threadId, { summary: threadSummary, events: [threadCreated(threadId, 1)] })
        return threadSummary
      }),
    createOrbThread: (input) =>
      Effect.sync(() => {
        const threadId = input.thread_id ?? Ids.ThreadId.make(`thread_remote_orb_${nextThread++}`)
        const threadSummary = summary(threadId, undefined, Ids.WorkspaceId.make(`project:${input.project_id}`))
        const orbId = Ids.OrbId.make(`orb_${threadId}`)
        threads.set(threadId, {
          summary: { ...threadSummary, orb_status: "running" },
          events: [threadCreated(threadId, 1, threadSummary.workspace_id)],
        })
        orbs.set(threadId, orbSummary(threadId, orbId, "running"))
        return { ...threadSummary, orb_status: "running" }
      }),
    orbChanges: () =>
      Effect.fail(new Client.SdkError({ message: "orb changes unavailable", operation: "orbChanges", status: 404 })),
    orbFiles: () =>
      Effect.fail(new Client.SdkError({ message: "orb files unavailable", operation: "orbFiles", status: 404 })),
    orbFile: () =>
      Effect.fail(new Client.SdkError({ message: "orb file unavailable", operation: "orbFile", status: 404 })),
    listOrbs: () => Effect.succeed([...orbs.values()]),
    getOrbByThread: (threadId) =>
      Effect.suspend(() => {
        const orb = orbs.get(threadId)
        if (orb === undefined)
          return Effect.fail(new Client.SdkError({ message: "missing", operation: "getOrbByThread", status: 404 }))
        return Effect.succeed(orb)
      }),
    pauseOrb: (orbId) => lifecycleOrb(orbs, threads, orbActions, orbId, "paused", "pause"),
    resumeOrb: (orbId) => lifecycleOrb(orbs, threads, orbActions, orbId, "running", "resume"),
    killOrb: (orbId) => lifecycleOrb(orbs, threads, orbActions, orbId, "killed", "kill"),
    listProjects: () => Effect.succeed([projectRecord("demo", "https://github.com/example/rika.git")]),
    createProject: (input) => Effect.succeed(projectDetail(input.name, input.repo_origin)),
    getProject: () => Effect.fail(new Client.SdkError({ message: "missing", operation: "getProject", status: 404 })),
    updateProject: () =>
      Effect.fail(new Client.SdkError({ message: "missing", operation: "updateProject", status: 404 })),
    setProjectSecret: () =>
      Effect.fail(new Client.SdkError({ message: "missing", operation: "setProjectSecret", status: 404 })),
    deleteProjectSecret: () =>
      Effect.fail(new Client.SdkError({ message: "missing", operation: "deleteProjectSecret", status: 404 })),
    listThreads: (input) =>
      Effect.sync(() => {
        workspaceIds.push(input?.workspace_id)
        return [...threads.values()].map((record) => record.summary)
      }),
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
    setThreadVisibility: (threadId, visibility) => Effect.sync(() => setVisibility(threads, threadId, visibility)),
    compactThread: (threadId) =>
      Effect.sync(() => {
        const record = threads.get(threadId)
        if (record === undefined) throw new Error(`Missing thread ${threadId}`)
        const event = contextCompacted(threadId, (record.events.at(-1)?.sequence ?? 0) + 1)
        compactions.push(threadId)
        record.events.push(event)
        for (const subscriber of subscribers) subscriber(event)
        return event
      }),
    forkThread: (threadId) =>
      Effect.sync(() => {
        const record = threads.get(threadId)
        if (record === undefined) throw new Error(`Missing thread ${threadId}`)
        const forkThreadId = Ids.ThreadId.make(`thread_remote_fork_${nextThread++}`)
        const cutoff = record.events.at(-1)?.sequence ?? 0
        const events = record.events.map((event, index) => forkEvent(event, forkThreadId, index + 1, threadId, cutoff))
        const forkSummary = summary(forkThreadId, record.summary.latest_message_text, record.summary.workspace_id)
        threads.set(forkThreadId, { summary: forkSummary, events })
        forks.push(threadId)
        return forkSummary
      }),
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
    setThreadPresence: (input) =>
      Effect.succeed({
        presence: {
          thread_id: input.thread_id,
          users: [{ user_id: input.user_id, state: input.state, last_seen: Common.TimestampMillis.make(10) }],
        },
      }),
    startTurn: (input) =>
      Effect.sync(() => {
        workspaceIds.push(input.workspace_id)
        turns.push(input.content)
        const events = turnEvents(input.thread_id, input.content, "remote response")
        const record = threads.get(input.thread_id)
        if (record !== undefined) {
          record.events.push(...events)
          record.summary = summary(input.thread_id, "remote response", input.workspace_id ?? workspaceId)
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

  return { client, turns, workspaceIds, orbActions, compactions, forks }
}

const emptyIdeStatus = { connected: false, capabilities: [], workspace_roots: [] } as const

const tournamentResult = (sourceThreadId: Ids.ThreadId, task: string): TournamentService.TournamentResult => {
  const winnerThreadId = Ids.ThreadId.make("thread_remote_tournament_winner")
  return {
    source_thread_id: sourceThreadId,
    task,
    branches: [
      {
        index: 1,
        thread_id: winnerThreadId,
        mode: "smart",
        status: "completed",
        candidate_id: "branch-1",
        turn_id: Ids.TurnId.make("turn_remote_tournament_winner"),
        content: "remote tournament answer",
      },
    ],
    ranking: [
      {
        rank: 1,
        candidate_id: "branch-1",
        thread_id: winnerThreadId,
        mode: "smart",
        median_score: 10,
        first_place_votes: 1,
        strengths: "best remote answer",
      },
    ],
    winner_thread_id: winnerThreadId,
    verdict: {
      winner_id: "branch-1",
      ranking: [{ candidate_id: "branch-1", median_score: 10, first_place_votes: 1 }],
      judges: [
        {
          winner_id: "branch-1",
          rationale: "best remote answer",
          scores: [
            {
              candidate_id: "branch-1",
              score: 10,
              strengths: "best remote answer",
              weaknesses: "none",
            },
          ],
        },
      ],
      rationale: "best remote answer",
    },
  }
}

const projectRecord = (name: string, repoOrigin: string): Remote.ProjectSummary => ({
  project_id: Ids.ProjectId.make(`project_${name}`),
  name,
  repo_origin: repoOrigin,
  default_branch: "main",
  template_id: null,
  env_keys: [],
  secret_names: [],
  created_at: Common.TimestampMillis.make(1),
  updated_at: Common.TimestampMillis.make(2),
})

const projectDetail = (name: string, repoOrigin: string): Remote.ProjectDetail => ({
  project_id: Ids.ProjectId.make(`project_${name}`),
  name,
  repo_origin: repoOrigin,
  default_branch: "main",
  template_id: null,
  env: {},
  secret_names: [],
  created_at: Common.TimestampMillis.make(1),
  updated_at: Common.TimestampMillis.make(2),
})

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

const setVisibility = (
  threads: Map<Ids.ThreadId, { summary: Remote.ThreadSummary; events: Array<Event.Event> }>,
  threadId: Ids.ThreadId,
  visibility: Remote.ThreadVisibility,
) => {
  const record = threads.get(threadId)
  if (record === undefined) throw new Error(`Missing thread ${threadId}`)
  record.summary = { ...record.summary, visibility }
  return record.summary
}

const summary = (
  threadId: Ids.ThreadId,
  latest?: string,
  inputWorkspaceId: Ids.WorkspaceId = workspaceId,
): Remote.ThreadSummary => ({
  thread_id: threadId,
  workspace_id: inputWorkspaceId,
  ...(latest === undefined ? {} : { latest_message_text: latest }),
  ...(latest === undefined ? {} : { title_text: latest }),
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  ...(latest === "old remote message" ? { orb_status: "running" as const } : {}),
  created_at: Common.TimestampMillis.make(1),
  updated_at: Common.TimestampMillis.make(2),
})

const orbSummary = (
  threadId: Ids.ThreadId,
  orbId: Ids.OrbId,
  status: Remote.OrbSummary["status"],
): Remote.OrbSummary => ({
  orb_id: orbId,
  thread_id: threadId,
  project_id: Ids.ProjectId.make("project_demo"),
  status,
  base_commit: "abc123",
  created_at: Common.TimestampMillis.make(1),
  last_active_at: Common.TimestampMillis.make(2),
  running_minutes: 0,
})

const lifecycleOrb = (
  orbs: Map<Ids.ThreadId, Remote.OrbSummary>,
  threads: Map<Ids.ThreadId, { summary: Remote.ThreadSummary; events: Array<Event.Event> }>,
  orbActions: Array<string>,
  orbId: Ids.OrbId,
  status: Remote.OrbSummary["status"],
  action: string,
) =>
  Effect.suspend(() => {
    const entry = [...orbs.entries()].find(([, orb]) => orb.orb_id === orbId)
    if (entry === undefined)
      return Effect.fail(new Client.SdkError({ message: "missing", operation: action, status: 404 }))
    const [threadId, orb] = entry
    const next = { ...orb, status }
    const record = threads.get(threadId)
    if (record !== undefined) record.summary = { ...record.summary, orb_status: status }
    orbs.set(threadId, next)
    orbActions.push(`${action}:${orbId}`)
    return Effect.succeed(next)
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

const forkEvent = (
  event: Event.Event,
  forkThreadId: Ids.ThreadId,
  sequence: number,
  sourceThreadId: Ids.ThreadId,
  cutoff: number,
): Event.Event => {
  const fields = {
    id: Ids.EventId.make(`event_remote_session_${forkThreadId}_${sequence}`),
    thread_id: forkThreadId,
    sequence,
  }
  if (event.type === "thread.created") {
    const forked: Event.ThreadCreated = {
      ...event,
      ...fields,
      data: {
        workspace_id: event.data.workspace_id,
        forked_from: { thread_id: sourceThreadId, sequence: cutoff },
      },
    }
    return forked
  }
  if (event.type === "message.added") {
    const forked: Event.MessageAdded = {
      ...event,
      ...fields,
      data: { message: { ...event.data.message, thread_id: forkThreadId } },
    }
    return forked
  }
  return { ...event, ...fields } as Event.Event
}

const threadCreated = (
  threadId: Ids.ThreadId,
  sequence: number,
  inputWorkspaceId: Ids.WorkspaceId = workspaceId,
): Event.ThreadCreated => ({
  ...base(threadId, sequence),
  type: "thread.created",
  data: { workspace_id: inputWorkspaceId },
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

const contextCompacted = (threadId: Ids.ThreadId, sequence: number): Event.ContextCompacted => ({
  ...base(threadId, sequence),
  type: "context.compacted",
  data: {
    summary: "older context summary",
    model: "gpt-5.5",
    trigger: "manual",
    tokens_before: 4000,
    tail_start_sequence: Math.max(1, sequence - 2),
  },
})
