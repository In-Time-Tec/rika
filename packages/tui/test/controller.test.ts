import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Stream } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Backend from "../src/backend"
import type * as Adapter from "../src/adapter"
import { Controller, Keymap, Keys, ViewState } from "../src/index"

const workspacePath = "/workspace/rika-controller-test"
const threadId = Ids.ThreadId.make("thread_controller")
const projectId = Ids.ProjectId.make("project_controller")
const orbThreadId = Ids.ThreadId.make("thread_controller_orb")
const userId = Ids.UserId.make("user_controller")
const otherUserId = Ids.UserId.make("sarah")

type Recorded = Array<ViewState.ViewState>

interface Harness {
  readonly rendered: Recorded
  readonly turns: Array<string>
  readonly turnParts: Array<ReadonlyArray<Message.ContentPart> | undefined>
  readonly commands: Array<string>
  readonly opened: Array<Adapter.OpenFileInput>
  readonly previewLoads: Array<Ids.ThreadId>
  readonly createdProjects: Array<Backend.CreateProjectInput>
  readonly orbThreads: Array<Backend.CreateOrbThreadInput>
  readonly presence: Array<Backend.PresenceRequest>
}

const run = (
  keys: ReadonlyArray<Keys.Key>,
  options: {
    failFirstTurn?: boolean
    seedEvents?: ReadonlyArray<Event.Event>
    actions?: ReadonlyArray<Adapter.Action>
    workspacePath?: string
    turnEvents?: (content: string) => ReadonlyArray<Event.Event>
    threads?: ReadonlyArray<Backend.ThreadOption>
    projects?: ReadonlyArray<Backend.ProjectOption>
    keymap?: Keymap.EffectiveKeymap
    ticks?: ReadonlyArray<void>
    userId?: Ids.UserId
    submitTurnError?: Error & { readonly active_user_id?: Ids.UserId }
  } = {},
) => {
  const runWorkspacePath = options.workspacePath ?? workspacePath
  const rendered: Recorded = []
  const turns: Array<string> = []
  const turnParts: Array<ReadonlyArray<Message.ContentPart> | undefined> = []
  const commands: Array<string> = []
  const opened: Array<Adapter.OpenFileInput> = []
  const previewLoads: Array<Ids.ThreadId> = []
  const createdProjects: Array<Backend.CreateProjectInput> = []
  const orbThreads: Array<Backend.CreateOrbThreadInput> = []
  const presence: Array<Backend.PresenceRequest> = []
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
    loadInitial: ({ workspace_path, mode, user_id }) =>
      Effect.succeed({
        thread_id: threadId,
        state: ViewState.initial({
          thread_id: threadId,
          workspace_path,
          mode,
          events: options.seedEvents ?? [],
          ...(user_id === undefined ? {} : { user_id }),
        }),
      }),
    streamTurn: ({ content, content_parts }) =>
      Stream.suspend(() => {
        turns.push(content)
        turnParts.push(content_parts)
        turnCount += 1
        if (options.failFirstTurn === true && turnCount === 1) return Stream.fail(new Error("model exploded"))
        return Stream.fromIterable(options.turnEvents?.(content) ?? turnEvents(content, `response to ${content}`))
      }),
    cancelTurn: () => Effect.void,
    runCommand: (context, command) =>
      Effect.sync(() => {
        commands.push(command)
        if (command === "/exit")
          return { ...context, state: ViewState.withNotice(context.state, "Goodbye."), exit: true }
        if (command === "/welcome")
          return {
            ...context,
            state: ViewState.initial({
              thread_id: context.thread_id,
              workspace_path: context.workspace_path,
              mode: context.mode,
            }),
            exit: false,
          }
        if (command === "/mode rush") {
          if (ViewState.modeLocked(context.state))
            return {
              ...context,
              state: ViewState.withNotice(context.state, "Mode is locked once a thread is active."),
              exit: false,
            }
          return { ...context, state: ViewState.withMode(context.state, "rush"), mode: "rush" as const, exit: false }
        }
        return { ...context, state: ViewState.withNotice(context.state, `Ran ${command}`), exit: false }
      }),
    listProjects: () => Effect.succeed(options.projects ?? []),
    createProject: (input) =>
      Effect.sync(() => {
        createdProjects.push(input)
        return {
          project_id: Ids.ProjectId.make(`project_${input.name}`),
          name: input.name,
          repo_origin: input.repo_origin,
        }
      }),
    createOrbThread: (input) =>
      Effect.sync(() => {
        orbThreads.push(input)
        return { thread_id: orbThreadId, workspace_id: Ids.WorkspaceId.make(`project:${input.project_id}`) }
      }),
    ...(options.submitTurnError === undefined
      ? {}
      : {
          submitTurn: () => Effect.fail(options.submitTurnError!),
          subscribeThreadEvents: () => Stream.empty,
        }),
    setThreadPresence: (input) =>
      Effect.sync(() => {
        presence.push(input)
      }),
    listThreads: () => Effect.succeed(options.threads ?? []),
    loadThreadPreview: ({ thread_id, workspace_path, mode }) =>
      Effect.sync(() => {
        previewLoads.push(thread_id)
        return {
          thread_id,
          state: ViewState.initial({
            thread_id,
            workspace_path,
            mode,
            events: [messageAdded(1, "preview body", Ids.TurnId.make("turn_controller_preview"), "assistant")],
          }),
        }
      }),
  }

  return Effect.runPromise(
    Controller.run(
      {
        backend,
        renderer: adapter,
        ticks: options.ticks === undefined ? Stream.empty : Stream.fromIterable(options.ticks),
        defaultMode: "smart",
        defaultWorkspace: workspacePath,
        ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
      },
      {
        workspace_root: runWorkspacePath,
        mode: "smart",
        ...(options.userId === undefined ? {} : { user_id: options.userId }),
      },
    ),
  ).then((exitCode): Harness & { exitCode: number } => ({
    exitCode,
    rendered,
    turns,
    turnParts,
    commands,
    opened,
    previewLoads,
    createdProjects,
    orbThreads,
    presence,
  }))
}

const quit = [Keys.ctrl("c"), Keys.ctrl("c")]

describe("Controller", () => {
  test("renders keymap warnings in the startup status line", async () => {
    const keymap = Keymap.effectiveKeymap({
      entries: { "palette.open": "ctrl+" },
      sources: { "palette.open": "user" },
    })
    const { rendered } = await run(quit, { keymap })

    expect(rendered.some((state) => (state.notice ?? "").includes("Keymap warning: palette.open"))).toBe(true)
  })

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

  test("throttles typing presence and returns active presence on submit", async () => {
    const keys = [...Keys.fromString("typing continuously"), Keys.enter, ...quit]
    const ticks = Array.from({ length: 39 }, () => undefined)
    const { presence } = await run(keys, { userId, ticks })

    expect(presence.filter((item) => item.state === "typing")).toHaveLength(1)
    expect(presence.at(-1)).toEqual({ thread_id: threadId, user_id: userId, state: "active" })
  })

  test("queues a turn when the remote backend reports an active user conflict", async () => {
    const error = Object.assign(new Error("Turn already active"), { active_user_id: otherUserId })
    const { rendered } = await run([...Keys.fromString("queue this"), Keys.enter, ...quit], {
      userId,
      submitTurnError: error,
    })

    expect(
      rendered.some(
        (state) => state.queued.includes("queue this") && state.notice === "sarah is running a turn — message queued",
      ),
    ).toBe(true)
  })

  test("Ctrl+O opens the command palette", async () => {
    const { rendered } = await run([Keys.ctrl("o"), ...quit])
    expect(rendered.some((state) => state.palette.open)).toBe(true)
  })

  test("leader r toggles orb-backed thread arming", async () => {
    const { rendered } = await run([Keys.ctrl("x"), Keys.make({ name: "r", sequence: "r" }), ...quit])

    expect(rendered.some((state) => state.remoteArm.enabled)).toBe(true)
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

  test("slash commands cannot reset an active turn before switching modes", async () => {
    const keys = [
      ...Keys.fromString("first"),
      Keys.enter,
      ...Keys.fromString("/welcome"),
      Keys.enter,
      ...Keys.fromString("/mode rush"),
      Keys.enter,
      ...quit,
    ]
    const { rendered, commands, turns } = await run(keys)

    expect(turns).toContain("first")
    expect(commands).toEqual(expect.arrayContaining(["/welcome", "/mode rush"]))
    expect(rendered.some((state) => state.notice === "Mode is locked once a thread is active.")).toBe(true)
    expect(rendered.some((state) => state.mode === "rush")).toBe(false)
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

  test("project commands select and create the project for the next orb-backed thread", async () => {
    const workspace = await tempGitWorkspace("https://github.com/example/rika.git")
    const project: Backend.ProjectOption = {
      project_id: projectId,
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
    }
    const { rendered, createdProjects } = await run(
      [
        ...Keys.fromString("/project select demo"),
        Keys.enter,
        ...Keys.fromString("/project create fresh"),
        Keys.enter,
        ...quit,
      ],
      { projects: [project], workspacePath: workspace },
    )

    expect(rendered.some((state) => state.remoteArm.project_name === "demo")).toBe(true)
    expect(createdProjects).toEqual([{ name: "fresh", repo_origin: "https://github.com/example/rika.git" }])
    expect(rendered.some((state) => state.remoteArm.project_name === "fresh")).toBe(true)
  })

  test("armed new thread provisions an orb-backed thread through the backend", async () => {
    const project: Backend.ProjectOption = {
      project_id: projectId,
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
    }
    const { rendered, commands, orbThreads } = await run(
      [
        ...Keys.fromString("/project select demo"),
        Keys.enter,
        ...Keys.fromString("/orb toggle"),
        Keys.enter,
        ...Keys.fromString("/new"),
        Keys.enter,
        ...quit,
      ],
      { projects: [project] },
    )

    expect(commands).not.toContain("/new")
    expect(orbThreads).toEqual([{ project_id: projectId, workspace_path: workspacePath, mode: "smart" }])
    expect(rendered.some((state) => state.thread_id === orbThreadId)).toBe(true)
    expect(rendered.at(-1)?.remoteArm.enabled).toBe(false)
    expect(rendered.some((state) => state.cards.some((card) => card.title.includes("Orb")))).toBe(true)
  })

  test("submit while busy queues the next prompt and Enter Enter steers it quietly", async () => {
    const keys = [
      ...Keys.fromString("first"),
      Keys.enter,
      ...Keys.fromString("second"),
      Keys.enter,
      Keys.enter,
      ...quit,
    ]
    const { rendered, turns } = await run(keys)

    expect(turns).toEqual(["first", "second"])
    expect(rendered.some((state) => state.queued.includes("second"))).toBe(true)
    expect(rendered.some((state) => (state.notice ?? "").includes("Steering"))).toBe(false)
  })

  test("selected queued prompts steer to the front of the next-turn queue", async () => {
    const keys = [
      ...Keys.fromString("first"),
      Keys.enter,
      ...Keys.fromString("a"),
      Keys.enter,
      ...Keys.fromString("b"),
      Keys.enter,
      Keys.make({ name: "up" }),
      Keys.enter,
      ...quit,
    ]
    const { turns } = await run(keys)

    expect(turns).toEqual(["first", "b", "a"])
  })

  test("Esc Esc interrupts the active turn and clears queued prompts", async () => {
    const keys = [
      ...Keys.fromString("first"),
      Keys.enter,
      ...Keys.fromString("second"),
      Keys.enter,
      Keys.escape,
      Keys.escape,
      ...quit,
    ]
    const { rendered, turns } = await run(keys)

    expect(turns).not.toContain("second")
    expect(rendered.some((state) => state.queued.includes("second"))).toBe(true)
    expect(rendered.some((state) => state.queued.length === 0 && !state.active)).toBe(true)
  })

  test("the switch thread palette command opens the thread switcher", async () => {
    const thread = Ids.ThreadId.make("thread_switch_target")
    const keys = [Keys.ctrl("o"), ...Keys.fromString("switch threads"), Keys.enter, Keys.enter, ...quit]
    const { commands, rendered } = await run(keys, {
      threads: [
        {
          thread_id: thread,
          label: "Rika terminal image drag-paste handling",
          title: "Rika terminal image drag-paste handling",
          preview: "Research OpenTUI and fix image placeholders.",
          updated_label: "17h ago",
          archived: false,
        },
      ],
    })

    expect(commands).not.toContain("/threads")
    expect(commands).toContain("/thread thread_switch_target")
    expect(rendered.some((state) => state.threadswitcher.open)).toBe(true)
    expect(
      rendered.some((state) => ViewState.selectedThreadSwitcherItem(state)?.preview_state.status === "loading"),
    ).toBe(true)
    expect(
      rendered.some((state) =>
        ViewState.filteredThreadSwitcherItems(state).some((item) =>
          item.title.includes("Rika terminal image drag-paste handling"),
        ),
      ),
    ).toBe(true)
    expect(rendered.some((state) => (state.notice ?? "").includes("Active threads"))).toBe(false)
  })

  test("bursty model streams are batched before rendering", async () => {
    const chunkCount = 512
    const keys = [...Keys.fromString("burst"), Keys.enter, ...quit]
    const { rendered } = await run(keys, { turnEvents: () => burstTurnEvents(chunkCount) })
    const assistant = rendered.at(-1)?.messages.find((message) => message.role === "assistant")

    expect(rendered.length).toBeLessThan(80)
    expect(assistant?.text.length).toBe(chunkCount)
  })

  test("ending a stream without a terminal turn event clears the active status", async () => {
    const turnId = Ids.TurnId.make("turn_controller_missing_terminal")
    const keys = [...Keys.fromString("missing terminal"), Keys.enter, ...quit]
    const { rendered } = await run(keys, {
      turnEvents: () => [
        turnStarted(turnId, 1),
        modelChunk(turnId, 2, "done"),
        messageAdded(3, "done", turnId, "assistant"),
      ],
    })
    const final = rendered.at(-1)

    expect(rendered.some((state) => state.messages.some((message) => message.text === "done"))).toBe(true)
    expect(final?.active).toBe(false)
    expect(final?.activity).toBe("idle")
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

const tempGitWorkspace = async (origin: string): Promise<string> => {
  const workspace = mkdtempSync(join(tmpdir(), "rika-controller-git-"))
  await runGit(workspace, ["init"])
  await runGit(workspace, ["remote", "add", "origin", origin])
  return workspace
}

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr)
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

const burstTurnEvents = (chunkCount: number): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make("turn_controller_burst")
  const chunks = Array.from({ length: chunkCount }, (_, index) => modelChunk(turnId, index + 2, "x"))
  return [
    turnStarted(turnId, 1),
    ...chunks,
    messageAdded(chunkCount + 2, "x".repeat(chunkCount), turnId, "assistant"),
    turnCompleted(turnId, chunkCount + 3),
  ]
}
