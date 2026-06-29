import { describe, expect, test } from "bun:test"
import { AgentLoop, ReviewService, SkillRegistry, ThreadService } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
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

const fakeAgentLayer = Layer.succeed(
  AgentLoop.Service,
  AgentLoop.Service.of({
    runTurn: Effect.fn("Tui.Session.test.runTurn")(function* (input: AgentLoop.RunTurnInput) {
      const events = turnEvents(input, "session response")
      return { thread_id: input.thread_id, turn_id: Ids.TurnId.make("turn_tui_session"), status: "completed", events }
    }),
    streamTurn: (input: AgentLoop.RunTurnInput) => Stream.fromIterable(turnEvents(input, "session response")),
    cancelTurn: Effect.fn("Tui.Session.test.cancelTurn")(function* (input: AgentLoop.CancelTurnInput) {
      return turnFailed(input.thread_id, input.turn_id, 1)
    }),
    queueTurn: Effect.fn("Tui.Session.test.queueTurn")(function* (input: AgentLoop.RunTurnInput) {
      return { thread_id: input.thread_id, position: 1 }
    }),
  }),
)

interface Harness {
  readonly rendered: Array<ViewState.ViewState>
}

const makeLayer = (rendered: Array<ViewState.ViewState>, keys: ReadonlyArray<Keys.Key>) => {
  const services = Layer.mergeAll(
    configLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(Common.TimestampMillis.make(1_970_000_000_000)),
    IdGenerator.sequenceLayer(1),
    Adapter.memoryLayer({ rendered, keys }),
    Ticker.memoryLayer,
    ReviewService.fakeLayer(() => Effect.succeed(fakeReviewResult)),
    SkillRegistry.fakeLayer([deploySkill]),
    fakeAgentLayer,
  )
  return Session.layer.pipe(Layer.provideMerge(ThreadService.layer.pipe(Layer.provideMerge(services))))
}

const line = (text: string): ReadonlyArray<Keys.Key> => [...Keys.fromString(text), Keys.enter]

const runSession = (lines: ReadonlyArray<string>): Promise<Harness & { exitCode: number }> => {
  const rendered: Array<ViewState.ViewState> = []
  const keys = lines.flatMap(line)
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Migration.migrate()
      return yield* Session.run({})
    }).pipe(Effect.provide(makeLayer(rendered, keys))),
  ).then((exitCode) => ({ exitCode, rendered }))
}

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
      "hello",
      "/mode rush",
      "/review --staged src/app.ts",
      "/new",
      "/exit",
    ])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("session response")
    expect(frames).toContain("Mode switched to rush")
    expect(frames).toContain("Review completed: 1 findings across 1 files")
    expect(frames).toContain("Started new thread")
    expect(rendered.some((state) => (state.notice ?? "").includes("Goodbye"))).toBe(true)
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
    expect(frames).toContain("Resumed thread thread_existing_tui")
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
      "/debug page logs",
      "/debug copy command",
      "/ide connect",
      "/mcp authenticate",
      "/mcp info",
      "/exit",
    ])

    const frames = text(rendered)
    expect(exitCode).toBe(0)
    expect(frames).toContain("Rika 0.0.0")
    expect(frames).toContain("Rika is Amp-compatible software.")
    expect(frames).toContain("ast-grep outline status: ready")
    expect(frames).toContain("Debug page logs are empty.")
    expect(frames).toContain("Debug command copied.")
    expect(frames).toContain("IDE connection requested.")
    expect(frames).toContain("MCP authentication requested.")
    expect(frames).toContain("No MCP servers connected.")
    expect(frames).not.toContain("Unknown command /welcome")
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

const turnEvents = (input: AgentLoop.RunTurnInput, response: string): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make("turn_tui_session")
  return [
    turnStarted(input.thread_id, turnId, 1),
    messageAdded(input.thread_id, 2, input.content, turnId, "user"),
    modelChunk(input.thread_id, turnId, 3, response),
    messageAdded(input.thread_id, 4, response, turnId, "assistant"),
    turnCompleted(input.thread_id, turnId, 5),
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

const threadCreated = (threadId: Ids.ThreadId, sequence: number): Event.ThreadCreated => ({
  ...base(threadId, sequence),
  type: "thread.created",
  data: { workspace_id: Ids.WorkspaceId.make(workspaceRoot) },
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
