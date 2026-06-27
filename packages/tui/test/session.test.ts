import { describe, expect, test } from "bun:test"
import { AgentLoop } from "@rika/agent"
import { Config, IdGenerator } from "@rika/core"
import { Database, Migration, ThreadEventLog } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { Renderer, Session, Terminal } from "../src/index"

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

const makeLayer = (terminal: Terminal.MemoryTerminal) => {
  const services = Layer.mergeAll(
    configLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    IdGenerator.sequenceLayer(1),
    Terminal.memoryLayer(terminal),
    fakeAgentLayer,
  )
  return Session.layer.pipe(Layer.provideMerge(services))
}

describe("TUI session", () => {
  test("runs an interactive prompt, switches modes, and starts a new thread through slash commands", async () => {
    const terminal: Terminal.MemoryTerminal = {
      inputs: ["hello", "/mode rush", "/new", "/exit"],
      frames: [],
      prompts: [],
    }

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Session.run({})
      }).pipe(Effect.provide(makeLayer(terminal))),
    )

    const frames = terminal.frames.map(Renderer.stripAnsi)
    expect(exitCode).toBe(0)
    expect(terminal.prompts).toEqual(["› ", "› ", "› ", "› "])
    expect(frames.join("\n")).toContain("session response")
    expect(frames.join("\n")).toContain("Mode switched to rush")
    expect(frames.join("\n")).toContain("Started new thread")
    expect(frames.at(-1)).toContain("Goodbye")
  })

  test("resumes a durable thread by replaying persisted events into the view", async () => {
    const existingThread = Ids.ThreadId.make("thread_existing_tui")
    const terminal: Terminal.MemoryTerminal = {
      inputs: [`/thread ${existingThread}`, "/exit"],
      frames: [],
      prompts: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(existingThread, 1))
        yield* ThreadEventLog.append(messageAdded(existingThread, 2, "old durable message"))
        return yield* Session.run({})
      }).pipe(Effect.provide(makeLayer(terminal))),
    )

    const frames = terminal.frames.map(Renderer.stripAnsi).join("\n")
    expect(frames).toContain("Resumed thread thread_existing_tui")
    expect(frames).toContain("old durable message")
  })
})

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
  text: string,
): Event.ModelStreamChunk => ({
  ...base(threadId, sequence, turnId),
  turn_id: turnId,
  type: "model.stream.chunk",
  data: { text, provider: "fake", model: "fake" },
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
