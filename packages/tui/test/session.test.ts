import { describe, expect, test } from "bun:test"
import { AgentLoop, ReviewService, SkillRegistry, ThreadService, TournamentService } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { Adapter, Keys, Session, Ticker, ViewState } from "../src/index"

const workspaceRoot = "/workspace/rika-tui-test"

const configLayer = Config.layerFromValues({
  workspace_root: workspaceRoot,
  data_dir: `${workspaceRoot}/.rika`,
  default_mode: "smart",
})

const fakeAgentLayer = (turns: Array<AgentLoop.RunTurnInput>) =>
  Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: Effect.fn("Tui.Session.test.runTurn")(function* (input: AgentLoop.RunTurnInput) {
        turns.push(input)
        const events = turnEvents(input, "session response")
        return { thread_id: input.thread_id, turn_id: Ids.TurnId.make("turn_tui_session"), status: "completed", events }
      }),
      streamTurn: (input: AgentLoop.RunTurnInput) => {
        turns.push(input)
        return Stream.fromIterable(turnEvents(input, "session response"))
      },
      cancelTurn: Effect.fn("Tui.Session.test.cancelTurn")(function* (input: AgentLoop.CancelTurnInput) {
        return { status: "inserted" as const, event: turnFailed(input.thread_id, input.turn_id, 1) }
      }),
    }),
  )

interface Harness {
  readonly rendered: Array<ViewState.ViewState>
}

const makeLayer = (
  rendered: Array<ViewState.ViewState>,
  keys: ReadonlyArray<Keys.Key>,
  turns: Array<AgentLoop.RunTurnInput> = [],
) => {
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const services = Layer.mergeAll(
    configLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(Common.TimestampMillis.make(1_970_000_000_000)),
    IdGenerator.sequenceLayer(1),
    redactorLayer,
    diagnosticsLayer,
    Adapter.memoryLayer({ rendered, keys }),
    Ticker.memoryLayer,
    ReviewService.fakeLayer(() => Effect.succeed(fakeReviewResult)),
    fakeTournamentLayer(),
    SkillRegistry.fakeLayer([deploySkill]),
    fakeAgentLayer(turns),
  )
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(services), Layer.provideMerge(diagnosticsLayer))
  return Session.layer.pipe(Layer.provideMerge(threadLayer))
}

const line = (text: string): ReadonlyArray<Keys.Key> => [...Keys.fromString(text), Keys.enter]

const runSessionKeys = (
  keys: ReadonlyArray<Keys.Key>,
  seedEvents: ReadonlyArray<Event.Event> = [],
): Promise<Harness & { exitCode: number }> => {
  const rendered: Array<ViewState.ViewState> = []
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Migration.migrate()
      for (const event of seedEvents) {
        const appended = yield* ThreadEventLog.append(event)
        yield* ThreadProjection.apply(appended)
      }
      return yield* Session.run({})
    }).pipe(Effect.provide(makeLayer(rendered, keys))),
  ).then((exitCode) => ({ exitCode, rendered }))
}

const runSession = (lines: ReadonlyArray<string>): Promise<Harness & { exitCode: number }> =>
  runSessionKeys(lines.flatMap(line))

const text = (rendered: ReadonlyArray<ViewState.ViewState>): string =>
  rendered
    .map((state) =>
      [
        state.notice ?? "",
        state.messages.map((message) => message.text).join("\n"),
        state.cards.map((card) => `${card.title} ${card.subtitle}`).join("\n"),
      ].join("\n"),
    )
    .join("\n")

describe("TUI session", () => {
  test("runs a turn, switches modes, runs a review, and starts a new thread through slash commands", async () => {
    const { exitCode, rendered } = await runSession([
      "/mode rush",
      "hello",
      "/review --staged src/app.ts",
      "/new",
      "/exit",
    ])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("session response")
    expect(rendered.some((state) => state.mode === "rush")).toBe(true)
    expect(frames).toContain("Review completed: 1 findings across 1 files")
    expect(frames).toContain("Started new thread")
    expect(rendered.some((state) => (state.notice ?? "").includes("Goodbye"))).toBe(true)
  })

  test("locks mode slash and palette commands once the thread has activity", async () => {
    const existingThread = Ids.ThreadId.make("thread_mode_locked_tui")
    const seedEvents = [threadCreated(existingThread, 1), messageAdded(existingThread, 2, "locked thread")]
    const direct = await runSessionKeys([`/thread ${existingThread}`, "/mode rush", "/exit"].flatMap(line), seedEvents)
    const palette = await runSessionKeys(
      [...line(`/thread ${existingThread}`), Keys.ctrl("o"), ...Keys.fromString("mode"), Keys.enter, ...line("/exit")],
      seedEvents,
    )

    for (const rendered of [direct.rendered, palette.rendered]) {
      expect(rendered.some((state) => state.notice === "Mode is locked once a thread is active.")).toBe(true)
      expect(rendered.some((state) => state.mode === "rush")).toBe(false)
    }
  })

  test("welcome cannot unlock mode after completed activity", async () => {
    const existingThread = Ids.ThreadId.make("thread_welcome_mode_locked_tui")
    const seedEvents = [threadCreated(existingThread, 1), messageAdded(existingThread, 2, "locked thread")]
    const { rendered } = await runSessionKeys(
      [`/thread ${existingThread}`, "/welcome", "/mode rush", "/exit"].flatMap(line),
      seedEvents,
    )

    expect(rendered.some((state) => state.notice === "Mode is locked once a thread is active.")).toBe(true)
    expect(rendered.some((state) => state.mode === "rush")).toBe(false)
  })

  test("uses an explicit workspace identity for interactive turns", async () => {
    const rendered: Array<ViewState.ViewState> = []
    const keys = ["hello", "/exit"].flatMap(line)
    const workspaceId = Ids.WorkspaceId.make("project:project_tui_session")
    const turns: Array<AgentLoop.RunTurnInput> = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Session.run({ workspace_id: workspaceId })
      }).pipe(Effect.provide(makeLayer(rendered, keys, turns))),
    )

    expect(turns[0]?.workspace_id).toBe(workspaceId)
  })

  test("resumes a durable thread by replaying persisted events into the view", async () => {
    const existingThread = Ids.ThreadId.make("thread_existing_tui")
    const rendered: Array<ViewState.ViewState> = []
    const keys = [`/thread ${existingThread}`, `/share ${existingThread}`, "/exit"].flatMap(line)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [
          threadCreated(existingThread, 1),
          messageAdded(existingThread, 2, "old durable message"),
        ]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* Session.run({})
      }).pipe(Effect.provide(makeLayer(rendered, keys))),
    )

    const frames = text(rendered)
    expect(rendered.some((state) => state.connecting_ticks > 0)).toBe(true)
    expect(frames).toContain("old durable message")
    expect(frames).toContain("Thread export JSON")
    expect(frames).toContain('"thread_id": "thread_existing_tui"')
  })

  test("lists and inspects installed skills through slash commands", async () => {
    const { exitCode, rendered } = await runSession(["/skills", "/skill deploy", "/exit"])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Installed skills (1)")
    expect(frames).toContain("deploy: Deploy safely")
    expect(frames).toContain("Deploy instructions")
  })

  test("handles Amp-compatible palette commands through slash commands", async () => {
    const { exitCode, rendered } = await runSession([
      "/version",
      "/credits",
      "/welcome",
      "/ast-grep outline status",
      "/mcp authenticate",
      "/mcp info",
      "/exit",
    ])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Rika 0.0.0")
    expect(frames).toContain("Rika is Amp-compatible software.")
    expect(frames).toContain("ast-grep outline status: ready")
    expect(frames).toContain("MCP authentication requested.")
    expect(frames).toContain("No MCP servers connected.")
    expect(frames).not.toContain("Unknown command /welcome")
  })

  test("reports manual compaction as remote-only in the local session", async () => {
    const { exitCode, rendered } = await runSession(["hello", "/compact", "/exit"])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Manual compaction requires the shared backend.")
    expect(frames).not.toContain("Unknown command /compact")
  })

  test("reports invalid local thread visibility commands as usage", async () => {
    const { exitCode, rendered } = await runSession(["/thread visibility group", "/thread visibility", "/exit"])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Usage: /thread visibility <private|workspace|unlisted>")
    expect(frames).not.toContain("Unknown command /thread")
  })

  test("forks the active local thread and opens the fork", async () => {
    const { exitCode, rendered } = await runSession(["/new", "/fork", "/exit"])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Forked thread")
    expect(rendered.at(-1)?.thread_id).not.toBe(rendered[0]?.thread_id)
    expect(frames).not.toContain("Unknown command /fork")
  })

  test("runs a local thread tournament through the backend runner", async () => {
    const { exitCode, rendered } = await runSession(["/new", "/tournament -n 2 compare branches", "/exit"])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Tournament winner: thread_tui_tournament_winner")
    expect(frames).toContain("1. thread_tui_tournament_winner deep2 10 best answer")
    expect(frames).not.toContain("Unknown command /tournament")
  })

  test("relaunch exits after recording a relaunch notice", async () => {
    const { exitCode, rendered } = await runSession(["/relaunch"])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Relaunch requested. Start Rika again after this session exits.")
  })
})

const deploySkill: SkillRegistry.Skill = {
  summary: {
    name: "deploy",
    description: "Deploy safely",
    source: "project",
    directory: "/workspace/.agents/skills/deploy",
    skill_file: "/workspace/.agents/skills/deploy/SKILL.md",
  },
  instructions: "Deploy instructions",
  resources: [{ path: "/workspace/.agents/skills/deploy/scripts/deploy.ts", relative_path: "scripts/deploy.ts" }],
}

const fakeReviewRun: ReviewService.ReviewRun = {
  review_id: "review_tui_session",
  thread_id: Ids.ThreadId.make("thread_tui_review"),
  artifact_id: Ids.ArtifactId.make("artifact_tui_review"),
  status: "completed",
  range: { kind: "staged", paths: ["src/app.ts"] },
  changed_files: ["src/app.ts"],
  checks: [
    {
      name: "security",
      severity_default: "high",
      tools: ["read"],
      source_path: ".agents/checks/security.md",
      scope_path: "",
      applies_to: ["src/app.ts"],
    },
  ],
  findings: [
    {
      check_name: "security",
      severity: "high",
      path: "src/app.ts",
      range: { start_line: 1, end_line: 1 },
      title: "Avoid eval",
      evidence: "eval(input)",
    },
  ],
  started_at: Common.TimestampMillis.make(1_970_000_000_000),
  completed_at: Common.TimestampMillis.make(1_970_000_000_000),
}

const fakeReviewResult: ReviewService.ReviewResult = {
  run: fakeReviewRun,
  artifact: {
    id: fakeReviewRun.artifact_id,
    thread_id: fakeReviewRun.thread_id,
    kind: "review",
    content: { review_id: fakeReviewRun.review_id },
    created_at: fakeReviewRun.completed_at,
  },
}

const fakeTournamentLayer = () =>
  Layer.succeed(
    TournamentService.Service,
    TournamentService.Service.of({
      run: (input) =>
        Effect.succeed({
          source_thread_id: input.thread_id,
          task: input.message,
          winner_thread_id: Ids.ThreadId.make("thread_tui_tournament_winner"),
          branches: [
            {
              index: 1,
              thread_id: Ids.ThreadId.make("thread_tui_tournament_one"),
              mode: "smart",
              status: "completed",
              candidate_id: "branch-1",
              turn_id: Ids.TurnId.make("turn_tui_tournament_one"),
              content: "first",
            },
            {
              index: 2,
              thread_id: Ids.ThreadId.make("thread_tui_tournament_winner"),
              mode: "deep2",
              status: "completed",
              candidate_id: "branch-2",
              turn_id: Ids.TurnId.make("turn_tui_tournament_two"),
              content: "winner",
            },
          ],
          ranking: [
            {
              rank: 1,
              candidate_id: "branch-2",
              thread_id: Ids.ThreadId.make("thread_tui_tournament_winner"),
              mode: "deep2",
              median_score: 10,
              first_place_votes: 1,
              strengths: "best answer",
            },
          ],
          verdict: {
            winner_id: "branch-2",
            ranking: [{ candidate_id: "branch-2", median_score: 10, first_place_votes: 1 }],
            judges: [
              {
                winner_id: "branch-2",
                rationale: "branch 2 wins",
                scores: [{ candidate_id: "branch-2", score: 10, strengths: "best answer", weaknesses: "none" }],
              },
            ],
            rationale: "branch 2 wins",
          },
        }),
    }),
  )

const turnEvents = (input: AgentLoop.RunTurnInput, response: string): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make("turn_tui_session")
  return [
    threadCreated(input.thread_id, 1, input.workspace_id),
    turnStarted(input.thread_id, turnId, 2),
    messageAdded(input.thread_id, 3, input.content, turnId, "user"),
    modelChunk(input.thread_id, turnId, 4, response),
    messageAdded(input.thread_id, 5, response, turnId, "assistant"),
    turnCompleted(input.thread_id, turnId, 6),
  ]
}

const base = (threadId: Ids.ThreadId, sequence: number, turnId?: Ids.TurnId): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_tui_session_${threadId}_${sequence}`),
  thread_id: threadId,
  ...(turnId === undefined ? {} : { turn_id: turnId }),
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const threadCreated = (
  threadId: Ids.ThreadId,
  sequence: number,
  workspaceId = Ids.WorkspaceId.make(workspaceRoot),
): Event.ThreadCreated => ({
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
  turnId = Ids.TurnId.make("turn_existing_tui"),
  role: Message.Role = "user",
): Event.MessageAdded => ({
  ...base(threadId, sequence, turnId),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_tui_session_${threadId}_${sequence}`),
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
