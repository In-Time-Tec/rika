import { describe, expect, test } from "bun:test"
import { ThreadService, TournamentService } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { Database, Migration, OrbStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Input, Output, Threads } from "../src/index"

const threadId = Ids.ThreadId.make("thread_cli_threads")
const workspaceId = Ids.WorkspaceId.make("workspace_cli_threads")
const projectId = Ids.ProjectId.make("project_cli_threads")
const turnId = Ids.TurnId.make("turn_cli_threads")
const forkTurnId = Ids.TurnId.make("turn_cli_threads_fork")
const now = Common.TimestampMillis.make(1_965_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-cli-threads-test",
  data_dir: "/workspace/rika-cli-threads-test/.rika",
  default_mode: "smart",
})

const makeLayer = (
  output: Output.MemoryOutput,
  tournamentLayer: Layer.Layer<TournamentService.Service> = fakeTournamentLayer([]),
  stdin = "",
) => {
  const baseServices = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(output),
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )
  const orbStoreLayer = OrbStore.layer.pipe(Layer.provideMerge(baseServices))
  const services = Layer.mergeAll(baseServices, orbStoreLayer)

  return Threads.layer
    .pipe(Layer.provideMerge(ThreadService.layer.pipe(Layer.provideMerge(services))))
    .pipe(Layer.provideMerge(Input.memoryLayer(stdin, false)), Layer.provideMerge(tournamentLayer))
}

describe("CLI thread commands", () => {
  test("prints thread search results as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* Threads.executeCommand({ type: "threads", action: "search", query: "cli" })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout[0]).not.toContain("\n")
    const results = Schema.decodeUnknownSync(Schema.Array(ThreadService.SearchResult))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(results[0]?.summary.thread_id).toBe(threadId)
    expect(results[0]?.matched.join("\n")).toContain("CLI thread command")
  })

  test("prints context usage in thread lists", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThreadWithContextUsage()
        return yield* Threads.executeCommand({ type: "threads", action: "list" })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const summaries = Schema.decodeUnknownSync(Schema.Array(ThreadService.ThreadSummary))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(summaries[0]).toMatchObject({
      thread_id: threadId,
      context_tokens: 42_000,
      context_window: 400_000,
    })
  })

  test("prints orb status in thread lists", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThreadWithOrbStatus()
        return yield* Threads.executeCommand({ type: "threads", action: "list" })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const parsed: unknown = JSON.parse(output.stdout[0] ?? "[]")
    const first = Array.isArray(parsed) ? parsed[0] : undefined
    expect(readOrbStatus(first)).toBe("running")
  })

  test("prints local share exports as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* Threads.executeCommand({ type: "threads", action: "share", thread_id: threadId })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const exported = Schema.decodeUnknownSync(ThreadService.ThreadExport)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(exported.thread_id).toBe(threadId)
    expect(exported.events.map((event) => event.type)).toEqual(["thread.created", "message.added"])
  })

  test("prints a forked local thread id as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedForkableThread()
        const exitCode = yield* Threads.executeCommand({
          type: "threads",
          action: "fork",
          thread_id: threadId,
          at_turn: forkTurnId,
        })
        const forkThreadId = Ids.ThreadId.make(JSON.parse(output.stdout[0] ?? '""'))
        const record = yield* ThreadService.open({ thread_id: forkThreadId })
        return { exitCode, forkThreadId, record }
      }).pipe(Effect.provide(makeLayer(output))),
    )

    const created = result.record.events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    expect(result.exitCode).toBe(0)
    expect(result.forkThreadId).not.toBe(threadId)
    expect(created?.data.forked_from).toEqual({ thread_id: threadId, sequence: 4 })
    expect(result.record.summary.latest_message_text).toBe("CLI fork body")
  })

  test("compacts a thread through the shared backend client", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<Ids.ThreadId> = []
    const event: Event.ContextCompacted = {
      id: Ids.EventId.make("thread_cli_threads_context_compacted"),
      thread_id: threadId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "context.compacted",
      data: {
        summary: "Goal\n- CLI compact",
        tail_start_sequence: 1,
        trigger: "manual",
        tokens_before: 120,
        model: "gpt-5.5",
      },
    }
    const exitCode = await Effect.runPromise(
      Threads.executeCommand({ type: "threads", action: "compact", thread_id: threadId }).pipe(
        Effect.provide(
          makeLayer(output).pipe(
            Layer.provideMerge(
              Threads.remoteClientLayer({
                ...emptyClient(),
                compactThread: (id) =>
                  Effect.sync(() => {
                    calls.push(id)
                    return event
                  }),
              }),
            ),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(calls).toEqual([threadId])
    expect(Schema.decodeUnknownSync(Event.ContextCompacted)(JSON.parse(output.stdout[0] ?? "{}"))).toEqual(event)
  })

  test("runs a thread tournament with stdin message and prints the ranking", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const inputs: Array<TournamentService.RunInput> = []
    const exitCode = await Effect.runPromise(
      Threads.executeCommand({
        type: "threads",
        action: "tournament",
        thread_id: threadId,
        message: "-",
        branch_count: 3,
        modes: ["smart", "deep2", "deep3"],
        rubric: "prefer concrete answers",
      }).pipe(Effect.provide(makeLayer(output, fakeTournamentLayer(inputs), "stdin tournament task\n"))),
    )

    expect(exitCode).toBe(0)
    expect(inputs).toEqual([
      {
        thread_id: threadId,
        message: "stdin tournament task",
        branch_count: 3,
        modes: ["smart", "deep2", "deep3"],
        rubric: "prefer concrete answers",
      },
    ])
    expect(output.stdout[0]).toContain("Rank")
    expect(output.stdout[0]).toContain("thread_cli_tournament_winner")
    expect(output.stdout[0]).toContain("Winner")
    expect(output.stdout[0]).toContain("rika --thread thread_cli_tournament_winner")
  })
})

const seedThread = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    const appended = yield* ThreadEventLog.append(messageAdded())
    yield* ThreadProjection.apply(appended)
  })

const seedThreadWithContextUsage = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [modelChunk(), turnCompletedWithUsage()]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const seedThreadWithOrbStatus = () =>
  Effect.gen(function* () {
    yield* seedThread()
    const orb = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setStatus(orb.orb_id, "running")
  })

const seedForkableThread = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [forkTurnStarted(), forkMessageAdded(), forkTurnCompleted()]) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const readOrbStatus = (value: unknown) => {
  if (typeof value !== "object" || value === null) return undefined
  const status = Object.getOwnPropertyDescriptor(value, "orb_status")?.value
  return typeof status === "string" ? status : undefined
}

const emptyClient = (): Client.Interface => ({
  backendHealth: unexpectedClientCall,
  createThread: unexpectedClientCall,
  createOrbThread: unexpectedClientCall,
  orbChanges: unexpectedClientCall,
  orbFiles: unexpectedClientCall,
  orbFile: unexpectedClientCall,
  listOrbs: unexpectedClientCall,
  getOrbByThread: unexpectedClientCall,
  pauseOrb: unexpectedClientCall,
  resumeOrb: unexpectedClientCall,
  killOrb: unexpectedClientCall,
  listProjects: unexpectedClientCall,
  createProject: unexpectedClientCall,
  getProject: unexpectedClientCall,
  updateProject: unexpectedClientCall,
  setProjectSecret: unexpectedClientCall,
  deleteProjectSecret: unexpectedClientCall,
  listThreads: unexpectedClientCall,
  openThread: unexpectedClientCall,
  previewThread: unexpectedClientCall,
  archiveThread: unexpectedClientCall,
  unarchiveThread: unexpectedClientCall,
  compactThread: unexpectedClientCall,
  forkThread: unexpectedClientCall,
  searchThreads: unexpectedClientCall,
  shareThread: unexpectedClientCall,
  referenceThread: unexpectedClientCall,
  subscribeThreadEvents: () => {
    throw new Error("Unexpected SDK stream call")
  },
  setThreadPresence: unexpectedClientCall,
  startTurn: unexpectedClientCall,
  interruptTurn: unexpectedClientCall,
  listArtifacts: unexpectedClientCall,
  getArtifact: unexpectedClientCall,
  connectIde: unexpectedClientCall,
  disconnectIde: unexpectedClientCall,
  updateIdeContext: unexpectedClientCall,
  ideStatus: unexpectedClientCall,
  openIdeFile: unexpectedClientCall,
  ideNavigationRequests: unexpectedClientCall,
})

const fakeTournamentLayer = (inputs: Array<TournamentService.RunInput>) =>
  Layer.succeed(
    TournamentService.Service,
    TournamentService.Service.of({
      run: (input) =>
        Effect.sync(() => {
          inputs.push(input)
          return tournamentResult(input)
        }),
    }),
  )

const tournamentResult = (input: TournamentService.RunInput): TournamentService.TournamentResult => {
  const winnerThreadId = Ids.ThreadId.make("thread_cli_tournament_winner")
  return {
    source_thread_id: input.thread_id,
    task: input.message,
    winner_thread_id: winnerThreadId,
    branches: [
      {
        index: 1,
        thread_id: Ids.ThreadId.make("thread_cli_tournament_one"),
        mode: "smart",
        status: "completed",
        candidate_id: "branch-1",
        turn_id: Ids.TurnId.make("turn_cli_tournament_one"),
        content: "first",
      },
      {
        index: 2,
        thread_id: winnerThreadId,
        mode: "deep2",
        status: "completed",
        candidate_id: "branch-2",
        turn_id: Ids.TurnId.make("turn_cli_tournament_two"),
        content: "winner",
      },
      {
        index: 3,
        thread_id: Ids.ThreadId.make("thread_cli_tournament_three"),
        mode: "deep3",
        status: "failed",
        error: "failed branch",
      },
    ],
    ranking: [
      {
        rank: 1,
        candidate_id: "branch-2",
        thread_id: winnerThreadId,
        mode: "deep2",
        median_score: 10,
        first_place_votes: 3,
        strengths: "best answer",
      },
      {
        rank: 2,
        candidate_id: "branch-1",
        thread_id: Ids.ThreadId.make("thread_cli_tournament_one"),
        mode: "smart",
        median_score: 7,
        first_place_votes: 0,
        strengths: "solid",
      },
    ],
    verdict: {
      winner_id: "branch-2",
      ranking: [
        { candidate_id: "branch-2", median_score: 10, first_place_votes: 3 },
        { candidate_id: "branch-1", median_score: 7, first_place_votes: 0 },
      ],
      judges: [
        {
          winner_id: "branch-2",
          rationale: "branch 2 wins",
          scores: [
            { candidate_id: "branch-1", score: 7, strengths: "solid", weaknesses: "less direct" },
            { candidate_id: "branch-2", score: 10, strengths: "best answer", weaknesses: "none" },
          ],
        },
      ],
      rationale: "branch 2 wins",
    },
  }
}

const unexpectedClientCall = () =>
  Effect.fail(new Client.SdkError({ message: "Unexpected SDK call", operation: "test" }))

const modelChunk = (): Event.ModelStreamChunk => ({
  id: Ids.EventId.make("thread_cli_threads_model_chunk"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "model.stream.chunk",
  data: { provider: "openai", model: "gpt-5.5", text: "answer" },
})

const turnCompletedWithUsage = (): Event.TurnCompleted => ({
  id: Ids.EventId.make("thread_cli_threads_turn_completed"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 3,
  version: 1,
  created_at: now,
  type: "turn.completed",
  data: { usage: { input_tokens: 42_000, output_tokens: 100, total_tokens: 42_100 } },
})

const messageAdded = (): Event.MessageAdded => ({
  id: Ids.EventId.make("thread_cli_threads_message_event"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("thread_cli_threads_message"),
      thread_id: threadId,
      turn_id: turnId,
      created_at: now,
      content: "CLI thread command search body",
    }),
  },
})

const forkTurnStarted = (): Event.TurnStarted => ({
  id: Ids.EventId.make("thread_cli_threads_fork_started"),
  thread_id: threadId,
  turn_id: forkTurnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "turn.started",
  data: {},
})

const forkMessageAdded = (): Event.MessageAdded => ({
  id: Ids.EventId.make("thread_cli_threads_fork_message_event"),
  thread_id: threadId,
  turn_id: forkTurnId,
  sequence: 3,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("thread_cli_threads_fork_message"),
      thread_id: threadId,
      turn_id: forkTurnId,
      created_at: now,
      content: "CLI fork body",
    }),
  },
})

const forkTurnCompleted = (): Event.TurnCompleted => ({
  id: Ids.EventId.make("thread_cli_threads_fork_completed"),
  thread_id: threadId,
  turn_id: forkTurnId,
  sequence: 4,
  version: 1,
  created_at: now,
  type: "turn.completed",
  data: {},
})
