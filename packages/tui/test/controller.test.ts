import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Stream } from "effect"
import type * as Backend from "../src/backend"
import type * as Adapter from "../src/adapter"
import { Controller, Keys, ViewState } from "../src/index"

const workspacePath = "/workspace/rika-controller-test"
const threadId = Ids.ThreadId.make("thread_controller")

type Recorded = Array<ViewState.ViewState>

interface Harness {
  readonly rendered: Recorded
  readonly turns: Array<string>
  readonly commands: Array<string>
}

const run = (
  keys: ReadonlyArray<Keys.Key>,
  options: {
    failFirstTurn?: boolean
    seedEvents?: ReadonlyArray<Event.Event>
    actions?: ReadonlyArray<Adapter.Action>
  } = {},
) => {
  const rendered: Recorded = []
  const turns: Array<string> = []
  const commands: Array<string> = []
  let turnCount = 0

  const adapter: Adapter.Adapter = {
    render: (state) => Effect.sync(() => rendered.push(state)),
    keys: Stream.fromIterable(keys),
    actions: Stream.fromIterable(options.actions ?? []),
    resizes: Stream.empty,
    setExit: () => Effect.void,
    editExternally: (text) => Effect.succeed(text),
    pasteImage: () => Effect.succeed(undefined),
  }

  const backend: Backend.SessionBackend<Error> = {
    loadInitial: ({ workspace_path, mode }) =>
      Effect.succeed({
        thread_id: threadId,
        state: ViewState.initial({ thread_id: threadId, workspace_path, mode, events: options.seedEvents ?? [] }),
      }),
    streamTurn: ({ content }) =>
      Stream.suspend(() => {
        turns.push(content)
        turnCount += 1
        if (options.failFirstTurn === true && turnCount === 1) return Stream.fail(new Error("model exploded"))
        return Stream.fromIterable(turnEvents(content, `response to ${content}`))
      }),
    cancelTurn: () => Effect.void,
    runCommand: (context, command) =>
      Effect.sync(() => {
        commands.push(command)
        if (command === "/exit")
          return { ...context, state: ViewState.withNotice(context.state, "Goodbye."), exit: true }
        return { ...context, state: ViewState.withNotice(context.state, `Ran ${command}`), exit: false }
      }),
    listThreads: () => Effect.succeed([]),
  }

  return Effect.runPromise(
    Controller.run(
      { backend, renderer: adapter, ticks: Stream.empty, defaultMode: "smart", defaultWorkspace: workspacePath },
      { workspace_root: workspacePath, mode: "smart" },
    ),
  ).then((exitCode): Harness & { exitCode: number } => ({ exitCode, rendered, turns, commands }))
}

const quit = [Keys.ctrl("c"), Keys.ctrl("c")]

describe("Controller", () => {
  test("contains a failing turn, renders the failure, runs the next turn, and exits 0", async () => {
    const keys = [...Keys.fromString("boom"), Keys.enter, ...Keys.fromString("again"), Keys.enter, ...quit]
    const { exitCode, rendered, turns } = await run(keys, { failFirstTurn: true })

    expect(exitCode).toBe(0)
    expect(turns).toEqual(["boom", "again"])
    expect(rendered.some((state) => (state.notice ?? "").includes("Turn failed"))).toBe(true)
    expect(rendered.some((state) => state.messages.some((message) => message.text.includes("response to again")))).toBe(
      true,
    )
  })

  test("Ctrl+O opens the command palette", async () => {
    const { rendered } = await run([Keys.ctrl("o"), ...quit])
    expect(rendered.some((state) => state.palette.open)).toBe(true)
  })

  test("Alt+T expands the focused tool card", async () => {
    const keys = [Keys.make({ name: "up" }), Keys.alt("t"), ...quit]
    const { rendered } = await run(keys, { seedEvents: [toolRequested(1), toolCompleted(2)] })
    const expanded = rendered.some((state) => state.expanded_ids.size > 0)
    expect(expanded).toBe(true)
  })

  test("adapter UI actions expand cards without keyboard focus", async () => {
    const { rendered } = await run(quit, {
      seedEvents: [toolRequested(1), toolCompleted(2)],
      actions: [{ _tag: "ToggleCard", card_id: "tool_controller" }],
    })
    expect(rendered.some((state) => state.expanded_ids.has("tool_controller"))).toBe(true)
  })

  test("word editing chords mutate the input before submit", async () => {
    const keys = [
      ...Keys.fromString("alpha beta gamma"),
      Keys.ctrl("w"),
      ...Keys.fromString("delta"),
      Keys.ctrl("u"),
      ...Keys.fromString("final prompt"),
      Keys.enter,
      ...quit,
    ]
    const { turns } = await run(keys)
    expect(turns).toContain("final prompt")
    expect(turns).not.toContain("alpha beta deltafinal prompt")
  })

  test("a typed /help runs through the backend command handler", async () => {
    const keys = [...Keys.fromString("/help"), Keys.enter, ...quit]
    const { commands } = await run(keys)
    expect(commands).toContain("/help")
  })

  test("the palette runs the selected command", async () => {
    const keys = [Keys.ctrl("o"), ...Keys.fromString("mode"), Keys.enter, ...quit]
    const { commands } = await run(keys)
    expect(commands).toContain("/mode rush")
  })
})

const turnEvents = (content: string, response: string): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make("turn_controller")
  return [
    turnStarted(turnId, 1),
    toolRequested(2),
    toolCompleted(3),
    modelChunk(turnId, 4, response),
    messageAdded(5, response, turnId, "assistant"),
    turnCompleted(turnId, 6),
  ]
}

const eventBase = (sequence: number, turnId?: Ids.TurnId): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_controller_${sequence}`),
  thread_id: threadId,
  ...(turnId === undefined ? {} : { turn_id: turnId }),
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const turnStarted = (turnId: Ids.TurnId, sequence: number): Event.TurnStarted => ({
  ...eventBase(sequence, turnId),
  turn_id: turnId,
  type: "turn.started",
  data: {},
})

const toolRequested = (sequence: number): Event.ToolCallRequested => ({
  ...eventBase(sequence),
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make("tool_controller"), name: "write", input: { path: "a.ts" } } },
})

const toolCompleted = (sequence: number): Event.ToolCallCompleted => ({
  ...eventBase(sequence),
  type: "tool.call.completed",
  data: {
    result: { id: Ids.ToolCallId.make("tool_controller"), name: "write", status: "success", output: { ok: true } },
  },
})

const modelChunk = (turnId: Ids.TurnId, sequence: number, text: string): Event.ModelStreamChunk => ({
  ...eventBase(sequence, turnId),
  turn_id: turnId,
  type: "model.stream.chunk",
  data: { text, provider: "fake", model: "fake" },
})

const messageAdded = (
  sequence: number,
  content: string,
  turnId: Ids.TurnId,
  role: Message.Role,
): Event.MessageAdded => ({
  ...eventBase(sequence, turnId),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_controller_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(content)],
      created_at: Common.TimestampMillis.make(sequence),
    },
  },
})

const turnCompleted = (turnId: Ids.TurnId, sequence: number): Event.TurnCompleted => ({
  ...eventBase(sequence, turnId),
  turn_id: turnId,
  type: "turn.completed",
  data: {},
})
