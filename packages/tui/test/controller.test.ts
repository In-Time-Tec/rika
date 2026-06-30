import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import type * as Backend from "../src/backend"
import type * as Adapter from "../src/adapter"
import { Controller, Keys, ViewState } from "../src/index"

const workspacePath = "/workspace/rika-controller-test"
const threadId = Ids.ThreadId.make("thread_controller")

type Recorded = Array<ViewState.ViewState>

interface Harness {
  readonly rendered: Recorded
  readonly turns: Array<string>
  readonly turnParts: Array<ReadonlyArray<Message.ContentPart> | undefined>
  readonly commands: Array<string>
  readonly opened: Array<Adapter.OpenFileInput>
}

const run = (
  keys: ReadonlyArray<Keys.Key>,
  options: {
    failFirstTurn?: boolean
    seedEvents?: ReadonlyArray<Event.Event>
    actions?: ReadonlyArray<Adapter.Action>
    workspacePath?: string
  } = {},
) => {
  const runWorkspacePath = options.workspacePath ?? workspacePath
  const rendered: Recorded = []
  const turns: Array<string> = []
  const turnParts: Array<ReadonlyArray<Message.ContentPart> | undefined> = []
  const commands: Array<string> = []
  const opened: Array<Adapter.OpenFileInput> = []
  let turnCount = 0

  const adapter: Adapter.Adapter = {
    render: (state) => Effect.sync(() => rendered.push(state)),
    keys: Stream.fromIterable(keys),
    actions: Stream.fromIterable(options.actions ?? []),
    resizes: Stream.empty,
    setExit: () => Effect.void,
    openFile: (input) =>
      Effect.sync(() => {
        opened.push(input)
      }),
    editExternally: (text) => Effect.succeed(text),
    pasteImage: () => Effect.succeed(".rika/pasted/test.png"),
  }

  const backend: Backend.SessionBackend<Error> = {
    loadInitial: ({ workspace_path, mode }) =>
      Effect.succeed({
        thread_id: threadId,
        state: ViewState.initial({ thread_id: threadId, workspace_path, mode, events: options.seedEvents ?? [] }),
      }),
    streamTurn: ({ content, content_parts }) =>
      Stream.suspend(() => {
        turns.push(content)
        turnParts.push(content_parts)
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
      { workspace_root: runWorkspacePath, mode: "smart" },
    ),
  ).then((exitCode): Harness & { exitCode: number } => ({ exitCode, rendered, turns, turnParts, commands, opened }))
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

  test("adapter file actions route through renderer file opening", async () => {
    const { opened } = await run(quit, {
      actions: [
        {
          _tag: "OpenFile",
          path: "packages/tui/src/adapter.ts",
          range: { start_line: 10, end_line: 12 },
        },
      ],
    })

    expect(opened).toEqual([
      {
        workspace_path: workspacePath,
        path: "packages/tui/src/adapter.ts",
        range: { start_line: 10, end_line: 12 },
      },
    ])
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

  test("text paste preserves multiline content until explicit submit", async () => {
    const keys = [Keys.paste("?not help\n@not a picker"), Keys.enter, ...quit]
    const { rendered, turns } = await run(keys)

    expect(turns).toContain("?not help\n@not a picker")
    expect(
      rendered.some((state) => ViewState.displayInputText(state.input).includes("[Pasted text #1 +2 lines]")),
    ).toBe(true)
    expect(rendered.some((state) => ViewState.hasCollapsedPaste(state.input))).toBe(true)
    expect(rendered.some((state) => state.shortcuts_open || state.filepicker.open)).toBe(false)
  })

  test("pasting the same collapsed text again inserts another collapsed paste", async () => {
    const keys = [Keys.paste("one\ntwo"), Keys.paste("one\ntwo"), Keys.enter, ...quit]
    const { rendered, turns } = await run(keys)

    expect(turns).toContain("one\ntwoone\ntwo")
    expect(rendered.some((state) => ViewState.displayInputText(state.input) === "one\ntwo")).toBe(false)
    expect(
      rendered.some((state) => ViewState.displayInputText(state.input).includes("[Pasted text #2 +2 lines]")),
    ).toBe(true)
  })

  test("pasted images render as placeholders but submit image parts", async () => {
    const realWorkspacePath = process.cwd()
    mkdirSync(`${realWorkspacePath}/.rika/pasted`, { recursive: true })
    writeFileSync(`${realWorkspacePath}/.rika/pasted/test.png`, "png-bytes")
    const keys = [
      ...Keys.fromString("In this image "),
      Keys.ctrl("v"),
      ...Keys.fromString("you can see it"),
      Keys.enter,
      ...quit,
    ]
    const { rendered, turns, turnParts } = await run(keys, { workspacePath: realWorkspacePath })

    expect(turns).toContain("In this image [Image 1] you can see it")
    expect(turnParts.at(0)).toEqual([
      Message.text("In this image "),
      {
        type: "image",
        media_type: "image/png",
        data: Buffer.from("png-bytes").toString("base64"),
        filename: ".rika/pasted/test.png",
        metadata: { label: "[Image 1]" },
      },
      Message.text(" you can see it"),
    ])
    expect(
      rendered.some((state) =>
        ViewState.displayInputText(state.input).includes("In this image [Image 1] you can see it"),
      ),
    ).toBe(true)
  })

  test("dropped image paths render as placeholders but submit image parts", async () => {
    const realWorkspacePath = process.cwd()
    mkdirSync(`${realWorkspacePath}/.rika/test-fixtures`, { recursive: true })
    writeFileSync(`${realWorkspacePath}/.rika/test-fixtures/drop.png`, "png")
    const keys = [Keys.paste(`${realWorkspacePath}/.rika/test-fixtures/drop.png`), Keys.enter, ...quit]
    const { rendered, turns, turnParts } = await run(keys, { workspacePath: realWorkspacePath })

    expect(turns).toContain("[Image 1]")
    expect(turnParts.at(0)).toEqual([
      {
        type: "image",
        media_type: "image/png",
        data: Buffer.from("png").toString("base64"),
        filename: ".rika/test-fixtures/drop.png",
        metadata: { label: "[Image 1]" },
      },
      Message.text(" "),
    ])
    expect(rendered.some((state) => ViewState.displayInputText(state.input).includes("[Image 1]"))).toBe(true)
  })

  test("dropped shell-escaped image paths with spaces submit image parts", async () => {
    const realWorkspacePath = process.cwd()
    mkdirSync(`${realWorkspacePath}/.rika/test-fixtures/path with spaces`, { recursive: true })
    writeFileSync(`${realWorkspacePath}/.rika/test-fixtures/path with spaces/drop image.png`, "png")
    const keys = [
      Keys.paste(`${realWorkspacePath}/.rika/test-fixtures/path\\ with\\ spaces/drop\\ image.png`),
      Keys.enter,
      ...quit,
    ]
    const { rendered, turns, turnParts } = await run(keys, { workspacePath: realWorkspacePath })

    expect(turns).toContain("[Image 1]")
    expect(turnParts.at(0)).toEqual([
      {
        type: "image",
        media_type: "image/png",
        data: Buffer.from("png").toString("base64"),
        filename: ".rika/test-fixtures/path with spaces/drop image.png",
        metadata: { label: "[Image 1]" },
      },
      Message.text(" "),
    ])
    expect(rendered.some((state) => ViewState.displayInputText(state.input).includes("[Image 1]"))).toBe(true)
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
