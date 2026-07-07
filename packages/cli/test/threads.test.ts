import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadService, TournamentService } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Embeddings } from "@rika/llm"
import { Database, Migration, OrbStore, ThreadEventLog, ThreadMemoryStore, ThreadProjection } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Input, Output, Threads } from "../src/index"

const threadId = Ids.ThreadId.make("thread_cli_threads")
const workspaceId = Ids.WorkspaceId.make("workspace_cli_threads")
const projectId = Ids.ProjectId.make("project_cli_threads")
const turnId = Ids.TurnId.make("turn_cli_threads")
const forkTurnId = Ids.TurnId.make("turn_cli_threads_fork")
const importThreadId = Ids.ThreadId.make("thread_cli_threads_import")
const importTurnId = Ids.TurnId.make("turn_cli_threads_import")
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
  embeddingsLayer: Layer.Layer<Embeddings.Service> = vectorEmbeddingsLayer([1, 0]),
) => {
  const databaseLayer = Database.memoryLayer
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const baseServices = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(output),
    databaseLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer)),
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
    diagnosticsLayer,
  )
  const orbStoreLayer = OrbStore.layer.pipe(Layer.provideMerge(baseServices))
  const services = Layer.mergeAll(baseServices, orbStoreLayer)

  return Threads.layer
    .pipe(
      Layer.provideMerge(ThreadService.layer.pipe(Layer.provideMerge(services), Layer.provideMerge(diagnosticsLayer))),
    )
    .pipe(
      Layer.provideMerge(Input.memoryLayer(stdin, false)),
      Layer.provideMerge(tournamentLayer),
      Layer.provideMerge(embeddingsLayer),
    )
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

  test("prints semantic thread search results ranked by score", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        yield* ThreadMemoryStore.put(
          memoryChunk("chunk_cli_threads_memory", threadId, turnId, "CLI semantic digest", [1, 0]),
        )
        yield* ThreadMemoryStore.put(
          memoryChunk(
            "chunk_cli_threads_other",
            Ids.ThreadId.make("thread_cli_threads_other"),
            Ids.TurnId.make("turn_cli_threads_other"),
            "Other digest",
            [0, 1],
          ),
        )
        return yield* Threads.executeCommand({
          type: "threads",
          action: "search",
          query: "semantic digest",
          semantic: true,
        })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const parsed = JSON.parse(output.stdout[0] ?? "[]")
    const first = Array.isArray(parsed) ? parsed[0] : undefined
    expect(readSummaryThreadId(first)).toBe(threadId)
    expect(readScore(first)).toBe(1)
  })

  test("falls back to lexical thread search with a notice when semantic embeddings are unavailable", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* Threads.executeCommand({
          type: "threads",
          action: "search",
          query: "cli",
          semantic: true,
        })
      }).pipe(
        Effect.provide(makeLayer(output, fakeTournamentLayer([]), "", Embeddings.layer(Embeddings.optionsFromEnv({})))),
      ),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr[0]).toContain("Semantic thread search unavailable")
    const results = Schema.decodeUnknownSync(Schema.Array(ThreadService.SearchResult))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(results[0]?.summary.thread_id).toBe(threadId)
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

  test("sets local thread visibility and prints the updated summary", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* Threads.executeCommand({
          type: "threads",
          action: "visibility",
          thread_id: threadId,
          visibility: "unlisted",
        })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const summary = Schema.decodeUnknownSync(ThreadService.ThreadSummary)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(summary).toMatchObject({ thread_id: threadId, visibility: "unlisted" })
  })

  test("rebuilds thread projections from the event log", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated())
        yield* ThreadEventLog.append(messageAdded())
        const before = yield* ThreadProjection.getThread(threadId)
        const exitCode = yield* Threads.executeCommand({ type: "threads", action: "rebuild-projection" })
        const after = yield* ThreadProjection.getThread(threadId)
        return { before, exitCode, after }
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(result.before).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(output.stdout[0] ?? "{}")).toEqual({ rebuilt: true })
    expect(result.after?.latest_message_text).toBe("CLI thread command search body")
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

  test("imports threads from another data dir and re-imports idempotently", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const sourceDataDir = mkdtempSync(join(tmpdir(), "rika-cli-threads-import-"))
    try {
      await Effect.runPromise(seedSourceDataDir(sourceDataDir))
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const firstExitCode = yield* Threads.executeCommand({
            type: "threads",
            action: "import",
            source_data_dir: sourceDataDir,
          })
          const summaries = yield* ThreadProjection.listThreads()
          const secondExitCode = yield* Threads.executeCommand({
            type: "threads",
            action: "import",
            source_data_dir: sourceDataDir,
          })
          const after = yield* ThreadProjection.listThreads()
          return { firstExitCode, summaries, secondExitCode, after }
        }).pipe(Effect.provide(makeLayer(output))),
      )

      expect(result.firstExitCode).toBe(0)
      expect(result.secondExitCode).toBe(0)
      expect(result.summaries.map((summary) => summary.thread_id)).toEqual([importThreadId])
      expect(result.summaries[0]?.latest_message_text).toBe("Imported thread body")
      expect(result.after.map((summary) => summary.thread_id)).toEqual([importThreadId])
      expect(JSON.parse(output.stdout[0] ?? "{}")).toEqual({
        imported_events: 2,
        skipped_events: 0,
        imported_artifacts: 0,
        skipped_artifacts: 0,
        rebuilt: true,
      })
      expect(JSON.parse(output.stdout[1] ?? "{}")).toEqual({
        imported_events: 0,
        skipped_events: 2,
        imported_artifacts: 0,
        skipped_artifacts: 0,
        rebuilt: true,
      })
    } finally {
      rmSync(sourceDataDir, { recursive: true, force: true })
    }
  })

  test("fails thread import when the source database is missing", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const sourceDataDir = mkdtempSync(join(tmpdir(), "rika-cli-threads-import-missing-"))
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          return yield* Threads.executeCommand({
            type: "threads",
            action: "import",
            source_data_dir: sourceDataDir,
          }).pipe(Effect.flip)
        }).pipe(Effect.provide(makeLayer(output))),
      )

      expect(result).toBeInstanceOf(Threads.ThreadsError)
      expect(Threads.formatError(result)).toContain("Source database not found")
    } finally {
      rmSync(sourceDataDir, { recursive: true, force: true })
    }
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
    yield* ThreadEventLog.appendAndProject(messageAdded())
  })

const seedThreadWithContextUsage = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [modelChunk(), turnCompletedWithUsage()]) {
      yield* ThreadEventLog.appendAndProject(event)
    }
  })

const seedThreadWithOrbStatus = () =>
  Effect.gen(function* () {
    yield* seedThread()
    const orb = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setStatus(orb.orb_id, "running")
  })

const seedSourceDataDir = (dataDir: string) =>
  Effect.gen(function* () {
    yield* Migration.migrate()
    yield* ThreadEventLog.append(importThreadCreated())
    yield* ThreadEventLog.append(importMessageAdded())
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Migration.layer, ThreadEventLog.layer).pipe(
        Layer.provideMerge(Database.layerFromPath(join(dataDir, "rika.sqlite"))),
      ),
    ),
  )

const seedForkableThread = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    for (const event of [forkTurnStarted(), forkMessageAdded(), forkTurnCompleted()]) {
      yield* ThreadEventLog.appendAndProject(event)
    }
  })

const memoryChunk = (
  id: string,
  thread_id: Ids.ThreadId,
  turn_id: Ids.TurnId,
  text: string,
  embedding: ReadonlyArray<number>,
): ThreadMemoryStore.ThreadMemoryChunk => ({
  id: Ids.ThreadMemoryChunkId.make(id),
  thread_id,
  turn_id,
  workspace_id: workspaceId,
  text,
  embedding: new Float32Array(embedding),
  created_at: now,
})

const vectorEmbeddingsLayer = (vector: ReadonlyArray<number>) =>
  Layer.succeed(
    Embeddings.Service,
    Embeddings.Service.of({
      dimensions: vector.length,
      availability: Effect.succeed({ available: true, model: "cli-thread-test", dimensions: vector.length }),
      embed: Effect.fn("Embeddings.embed.cliThreadTest")(function* (texts: ReadonlyArray<string>) {
        return texts.map(() => new Float32Array(vector))
      }),
    }),
  )

const readOrbStatus = (value: unknown) => {
  if (typeof value !== "object" || value === null) return undefined
  const status = Object.getOwnPropertyDescriptor(value, "orb_status")?.value
  return typeof status === "string" ? status : undefined
}

const readSummaryThreadId = (value: unknown) => {
  if (typeof value !== "object" || value === null) return undefined
  const summary = Object.getOwnPropertyDescriptor(value, "summary")?.value
  if (typeof summary !== "object" || summary === null) return undefined
  const summaryThreadId = Object.getOwnPropertyDescriptor(summary, "thread_id")?.value
  return typeof summaryThreadId === "string" ? summaryThreadId : undefined
}

const readScore = (value: unknown) => {
  if (typeof value !== "object" || value === null) return undefined
  const score = Object.getOwnPropertyDescriptor(value, "score")?.value
  return typeof score === "number" ? score : undefined
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
  setThreadVisibility: unexpectedClientCall,
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

const threadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("thread_cli_threads_created"),
  thread_id: threadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

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

const importThreadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("thread_cli_threads_import_created"),
  thread_id: importThreadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const importMessageAdded = (): Event.MessageAdded => ({
  id: Ids.EventId.make("thread_cli_threads_import_message_event"),
  thread_id: importThreadId,
  turn_id: importTurnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("thread_cli_threads_import_message"),
      thread_id: importThreadId,
      turn_id: importTurnId,
      created_at: now,
      content: "Imported thread body",
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
