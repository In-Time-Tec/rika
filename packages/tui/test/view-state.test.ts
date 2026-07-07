import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_view_state")
const turnId = Ids.TurnId.make("turn_view_state")
const userId = Ids.UserId.make("user_view_state")
const otherUserId = Ids.UserId.make("sarah")

const base = (): ViewState.ViewState =>
  ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart" })

describe("ViewState input editing", () => {
  test("remote arm is session scoped and toggles on demand", () => {
    const idle = base()
    expect(idle.remoteArm).toEqual({ enabled: false })

    const armed = ViewState.toggleRemoteArm(idle)
    const selected = ViewState.withRemoteProject(armed, "demo")
    const disarmed = ViewState.toggleRemoteArm(selected)

    expect(armed.remoteArm).toEqual({ enabled: true })
    expect(selected.remoteArm).toEqual({ enabled: true, project_name: "demo" })
    expect(disarmed.remoteArm).toEqual({ enabled: false, project_name: "demo" })
  })

  test("insertText, cursor movement, and backspace are pure", () => {
    let state = base()
    state = ViewState.insertText(state, "hello")
    expect(state.input).toEqual({ text: "hello", cursor: 5, attachments: [] })
    state = ViewState.moveCursorLeft(ViewState.moveCursorLeft(state))
    expect(state.input.cursor).toBe(3)
    state = ViewState.insertText(state, "X")
    expect(state.input.text).toBe("helXlo")
    state = ViewState.backspace(state)
    expect(state.input.text).toBe("hello")
    state = ViewState.moveCursorHome(state)
    expect(state.input.cursor).toBe(0)
    state = ViewState.moveCursorEnd(state)
    expect(state.input.cursor).toBe(5)
    state = ViewState.newline(state)
    expect(state.input.text).toBe("hello\n")
    state = ViewState.clearInput(state)
    expect(state.input).toEqual({ text: "", cursor: 0, attachments: [] })
  })

  test("word and line edits update the prompt around the cursor", () => {
    let state = withInput("alpha beta gamma")
    state = ViewState.deleteWordBackward(state)
    expect(state.input).toEqual({ text: "alpha beta ", cursor: 11, attachments: [] })
    state = ViewState.moveWordLeft(state)
    expect(state.input.cursor).toBe(6)
    state = ViewState.deleteWordForward(state)
    expect(state.input).toEqual({ text: "alpha  ", cursor: 6, attachments: [] })

    state = withInput("first second third", 13)
    state = ViewState.deleteToLineStart(state)
    expect(state.input).toEqual({ text: "third", cursor: 0, attachments: [] })

    state = withInput("first second third", 6)
    state = ViewState.deleteToLineEnd(state)
    expect(state.input).toEqual({ text: "first ", cursor: 6, attachments: [] })
  })

  test("image attachments keep the prompt path and display a placeholder", () => {
    let state = ViewState.insertText(base(), "In this image ")
    state = ViewState.insertImageAttachment(state, ".rika/pasted/test.png")
    state = ViewState.insertText(state, "you can see it vs this image ")
    state = ViewState.insertImageAttachment(state, ".rika/pasted/other.png")
    state = ViewState.insertText(state, "you see that")

    expect(ViewState.submitText(state)).toBe(
      "In this image [Image 1] you can see it vs this image [Image 2] you see that",
    )
    expect(ViewState.submitInputParts(state)).toEqual([
      { type: "text", text: "In this image " },
      { type: "image", path: ".rika/pasted/test.png", text: "[Image 1]" },
      { type: "text", text: " you can see it vs this image " },
      { type: "image", path: ".rika/pasted/other.png", text: "[Image 2]" },
      { type: "text", text: " you see that" },
    ])
    expect(ViewState.displayInputText(state.input)).toBe(
      "In this image [Image 1] you can see it vs this image [Image 2] you see that",
    )
  })

  test("pasted text displays as a collapsed token but submits full content", () => {
    const state = ViewState.insertPastedText(base(), "line one\nline two\nline three")

    expect(ViewState.submitText(state)).toBe("line one\nline two\nline three")
    expect(ViewState.displayInputText(state.input)).toBe("[Pasted text #1 +3 lines]")

    const spaced = ViewState.insertText(state, " ")
    expect(ViewState.submitText(spaced)).toBe("line one\nline two\nline three ")
    expect(ViewState.displayInputText(spaced.input)).toBe("[Pasted text #1 +3 lines] ")
  })
})

describe("ViewState focus + expansion", () => {
  test("focus walks cards and toggleDetails expands the focused card", () => {
    const state = withCards()
    expect(state.cards.length).toBe(2)
    const focused = ViewState.focusNext(state)
    expect(focused.focus_index).toBe(0)
    const card = state.cards[0]!
    expect(ViewState.isCardCollapsed(focused, card)).toBe(true)
    const expanded = ViewState.toggleDetails(focused)
    expect(ViewState.isCardCollapsed(expanded, card)).toBe(false)
    expect(expanded.expanded_ids.has(card.id)).toBe(true)
  })

  test("toggleDetails with no focus flips session details and thinking", () => {
    const state = withCards()
    const toggled = ViewState.toggleDetails(state)
    expect(toggled.details_expanded).toBe(true)
    expect(toggled.thinking.visible).toBe(true)
    const card = state.cards[0]!
    expect(ViewState.isCardCollapsed(toggled, card)).toBe(false)
  })

  test("direct card and tool-group toggles do not depend on keyboard focus", () => {
    const state = withCards()
    const card = state.cards[0]!
    const expanded = ViewState.toggleCard(state, card.id)
    expect(ViewState.isCardCollapsed(expanded, card)).toBe(false)
    expect(expanded.expanded_ids.has(card.id)).toBe(true)

    const grouped = ViewState.toggleToolGroup(state)
    expect(grouped.tool_group_expanded).toBe(true)
    expect(grouped.thinking.visible).toBe(false)
  })
})

describe("ViewState queue + thinking", () => {
  test("renders remote presence and attributed user messages", () => {
    const state = ViewState.withPresence(
      ViewState.applyEvent(
        ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart", user_id: userId }),
        messageAddedWithUser(1, "hello from Sarah", otherUserId),
      ),
      {
        thread_id: threadId,
        users: [
          { user_id: userId, state: "active", last_seen: Common.TimestampMillis.make(1) },
          { user_id: otherUserId, state: "typing", last_seen: Common.TimestampMillis.make(2) },
        ],
      },
    )

    expect(state.presence).toEqual([{ user_id: otherUserId, state: "typing" }])
    expect(ViewState.presenceStatusLabel(state)).toMatchInlineSnapshot(`"◈ sarah is typing…"`)
    expect(ViewState.messageDisplayText(state, state.messages[0]!)).toMatchInlineSnapshot(`"sarah › hello from Sarah"`)
  })

  test("context usage stays hidden until usage arrives and shifts thresholds", () => {
    const hidden = base()
    const initial = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace/rika",
      mode: "smart",
      context_tokens: 280_000,
      context_window: 400_000,
    })
    const normal = ViewState.applyEvent(base(), turnCompletedWithUsage(1, 120_000))
    const warning = ViewState.applyEvent(base(), turnCompletedWithUsage(2, 280_000))
    const danger = ViewState.applyEvent(base(), turnCompletedWithUsage(3, 360_000))

    expect(hidden.context_usage).toBeUndefined()
    expect(initial.context_usage).toEqual({ tokens: 280_000, window: 400_000, percent: 70, tone: "warning" })
    expect(normal.context_usage).toEqual({ tokens: 120_000, window: 400_000, percent: 30, tone: "normal" })
    expect(ViewState.contextUsageLabel(normal.context_usage!)).toBe("ctx 30%")
    expect(warning.context_usage).toEqual({ tokens: 280_000, window: 400_000, percent: 70, tone: "warning" })
    expect(danger.context_usage).toEqual({ tokens: 360_000, window: 400_000, percent: 90, tone: "danger" })
  })

  test("context pruning renders as a concise system card", () => {
    const state = ViewState.applyEvent(base(), contextPruned(1))

    expect(state.cards.at(-1)).toMatchObject({
      kind: "system",
      title: "Context pruned",
      subtitle: "2 tools · 24000 tokens",
      status: "info",
    })
  })

  test("reasoning tiers apply only to deep mode", () => {
    let smart = base()
    expect(smart.reasoning_effort).toBe(0)
    smart = ViewState.cycleReasoning(smart)
    expect(smart.reasoning_effort).toBe(0)

    const rush = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "rush" })
    expect(ViewState.cycleReasoning(rush).reasoning_effort).toBe(0)

    let deep = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" })
    expect(deep.mode).toBe("deep3")
    expect(deep.reasoning_effort).toBe(3)
    deep = ViewState.cycleReasoning(deep)
    expect(deep.mode).toBe("deep1")
    expect(deep.reasoning_effort).toBe(1)
    deep = ViewState.cycleReasoning(deep)
    expect(deep.mode).toBe("deep2")
    expect(deep.reasoning_effort).toBe(2)
    deep = ViewState.cycleReasoning(deep)
    expect(deep.mode).toBe("deep3")
    expect(deep.reasoning_effort).toBe(3)
  })

  test("reasoning tier cycling locks once the thread has activity", () => {
    const idle = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" })
    const cycled = ViewState.cycleReasoning(idle)

    expect(cycled.mode).toBe("deep1")
    expect(cycled.reasoning_effort).toBe(1)

    const active = ViewState.applyEvent(idle, messageAddedWithUser(1, "hello", userId))
    const locked = ViewState.cycleReasoning(active)

    expect(ViewState.hasActivity(locked)).toBe(true)
    expect(locked.mode).toBe("deep3")
    expect(locked.reasoning_effort).toBe(3)
  })

  test("mode switches lock while a turn is active before transcript entries arrive", () => {
    const idle = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" })
    const active = ViewState.applyEvent(idle, turnStarted(1))

    const direct = ViewState.withMode(active, "rush")
    const cycled = ViewState.cycleReasoning(active)
    const picked = ViewState.modePickerApply(ViewState.modePickerMove(ViewState.openModePicker(active), 1))

    expect(active.active).toBe(true)
    expect(ViewState.hasActivity(active)).toBe(false)
    expect(direct.mode).toBe("deep3")
    expect(direct.reasoning_effort).toBe(3)
    expect(cycled.mode).toBe("deep3")
    expect(cycled.reasoning_effort).toBe(3)
    expect(picked.mode).toBe("deep3")
    expect(picked.reasoning_effort).toBe(3)
  })

  test("mode picker switches before activity and locks after activity", () => {
    const idle = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep3" })
    const switched = ViewState.modePickerApply(ViewState.modePickerMove(ViewState.openModePicker(idle), 1))

    expect(switched.mode).toBe("rush")

    const active = ViewState.applyEvent(idle, messageAddedWithUser(1, "hello", userId))
    const locked = ViewState.modePickerApply(ViewState.modePickerMove(ViewState.openModePicker(active), 1))

    expect(ViewState.hasActivity(locked)).toBe(true)
    expect(locked.mode).toBe("deep3")
    expect(locked.reasoning_effort).toBe(3)
  })

  test("enqueue and dequeue messages in order", () => {
    let state = ViewState.enqueueMessage(ViewState.enqueueMessage(base(), "one"), "two")
    expect(state.queued).toEqual(["one", "two"])
    const first = ViewState.dequeueMessage(state)
    expect(first.next).toBe("one")
    state = first.state
    expect(state.queued).toEqual(["two"])
    expect(ViewState.dequeueMessage(ViewState.dequeueMessage(state).state).next).toBeUndefined()
  })

  test("queueUp/queueDown select queued messages and dequeueSelected removes the focused one", () => {
    let state = ViewState.enqueueMessage(ViewState.enqueueMessage(base(), "a"), "b")
    expect(state.queue_selected).toBe(-1)
    state = ViewState.queueUp(state)
    expect(state.queue_selected).toBe(1)
    state = ViewState.queueUp(state)
    expect(state.queue_selected).toBe(0)
    state = ViewState.queueDown(state)
    expect(state.queue_selected).toBe(1)
    expect(ViewState.selectedQueued(state)).toBe("b")
    state = ViewState.dequeueSelected(state)
    expect(state.queued).toEqual(["a"])
    expect(state.queue_selected).toBe(0)
  })

  test("promoteSelectedOrNextQueued moves the selected or next queued message to the front", () => {
    let state = ViewState.enqueueMessage(ViewState.enqueueMessage(ViewState.enqueueMessage(base(), "a"), "b"), "c")
    state = ViewState.queueUp(state)
    expect(ViewState.selectedQueued(state)).toBe("c")
    state = ViewState.promoteSelectedOrNextQueued(state)
    expect(state.queued).toEqual(["c", "a", "b"])
    expect(state.queue_selected).toBe(-1)

    state = ViewState.promoteSelectedOrNextQueued(state)
    expect(state.queued).toEqual(["c", "a", "b"])
    expect(state.queue_selected).toBe(-1)
  })

  test("clearQueuedMessages removes all queued prompts and queue focus", () => {
    const state = ViewState.clearQueuedMessages(ViewState.queueUp(ViewState.enqueueMessage(base(), "queued")))

    expect(state.queued).toEqual([])
    expect(state.queue_selected).toBe(-1)
  })

  test("Tab message nav: navPrevMessage selects prior user messages, editNavMessage loads into input", () => {
    const state: ViewState.ViewState = {
      ...base(),
      entries: [
        { kind: "message", message: { id: "u1", role: "user", text: "first prompt" } },
        { kind: "message", message: { id: "a1", role: "assistant", text: "ok" } },
        { kind: "message", message: { id: "u2", role: "user", text: "second prompt" } },
      ],
    }
    const one = ViewState.navPrevMessage(state)
    expect(one.nav_index).toBe(0)
    expect(ViewState.selectedNavId(one)).toBe("u2")
    const two = ViewState.navPrevMessage(one)
    expect(ViewState.selectedNavId(two)).toBe("u1")
    const edited = ViewState.editNavMessage(two)
    expect(edited.input.text).toBe("first prompt")
    expect(edited.nav_index).toBe(-1)
  })

  test("prompt history: pushHistory stores and historyPrev/Next cycle", () => {
    let state = ViewState.pushHistory(ViewState.pushHistory(base(), "first"), "second")
    expect(state.history).toEqual(["first", "second"])
    state = ViewState.historyPrev(state)
    expect(state.input.text).toBe("second")
    state = ViewState.historyPrev(state)
    expect(state.input.text).toBe("first")
    state = ViewState.historyNext(state)
    expect(state.input.text).toBe("second")
    state = ViewState.historyNext(state)
    expect(state.input.text).toBe("")
    expect(state.history_index).toBe(-1)
  })

  test("withReasoningDelta appends and toggleThinking flips visibility", () => {
    let state = ViewState.withReasoningDelta(ViewState.withReasoningDelta(base(), "abc"), "def")
    expect(state.thinking.text).toBe("abcdef")
    expect(state.thinking.visible).toBe(false)
    state = ViewState.toggleThinking(state)
    expect(state.thinking.visible).toBe(true)
  })

  test("applyEvent handles a model.reasoning.delta event when present", () => {
    const reasoning: Event.ModelReasoningDelta = {
      id: Ids.EventId.make("event_reasoning_1"),
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: Common.TimestampMillis.make(1),
      type: "model.reasoning.delta",
      data: { text: "pondering", provider: "fake", model: "fake" },
    }
    const state = ViewState.applyEvent(base(), reasoning)
    expect(state.thinking.text).toBe("pondering")
  })

  test("tool input streaming clears assistant text and counts generated tool input", () => {
    const started = ViewState.applyEvent(
      { ...base(), streaming_text: '{"tool_' },
      {
        ...eventBase(1),
        turn_id: turnId,
        type: "tool.call.input.started",
        data: { id: Ids.ToolCallId.make("tool_input_started"), name: "write" },
      },
    )

    expect(started.streaming_text).toBe("")
    expect(started.activity).toBe("streaming")
    expect(started.cards.at(-1)).toMatchObject({
      id: "tool_input_started",
      kind: "tool",
      title: "write",
      status: "info",
    })

    const streaming = ViewState.applyEvent(started, {
      ...eventBase(2),
      turn_id: turnId,
      type: "tool.call.input.delta",
      data: { id: Ids.ToolCallId.make("tool_input_started"), text: '{"path":"a.ts"}' },
    })

    expect(streaming.activity).toBe("streaming")
    expect(streaming.generated_text_chars).toBe('{"path":"a.ts"}'.length)

    const requested = ViewState.applyEvent(streaming, toolRequested(3, "tool_input_started", "write", { path: "a.ts" }))

    expect(requested.activity).toBe("running-tools")
    expect(requested.cards.at(-1)).toMatchObject({ id: "tool_input_started", status: "running" })
  })

  test("streaming preview is bounded while generated character count stays exact", () => {
    const chunk = "0123456789\n".repeat(200)
    const chunks = Math.ceil((ViewState.maxStreamingTextChars * 2) / chunk.length)
    const state = Array.from({ length: chunks }, (_, index) => index + 1).reduce(
      (current, sequence) =>
        ViewState.applyEvent(current, {
          ...eventBase(sequence),
          turn_id: turnId,
          type: "model.stream.chunk",
          data: { text: chunk, provider: "fake", model: "fake" },
        }),
      base(),
    )

    expect(state.generated_text_chars).toBe(chunk.length * chunks)
    expect(state.streaming_text.length).toBeLessThanOrEqual(ViewState.maxStreamingTextChars)
    expect(state.streaming_text.endsWith("0123456789\n")).toBe(true)
  })
})

describe("ViewState tool display", () => {
  test("read rows name the file and do not expose file contents", () => {
    const state = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace/rika",
      mode: "smart",
      events: [
        toolRequested(1, "read_agents", "read", { path: "AGENTS.md" }),
        toolCompleted(2, "read_agents", "read", {
          type: "hashline.read",
          path: "AGENTS.md",
          content: "do not render this content",
          total_lines: 40,
          render: {
            kind: "file",
            renderer: "@pierre/diffs",
            collapsed: true,
            file: { name: "AGENTS.md", contents: "do not render this content" },
          },
        }),
      ],
    })

    const card = state.cards.find((candidate) => candidate.id === "read_agents")
    expect(card).toMatchObject({ title: "Read AGENTS.md", status: "success", expandable: false, path: "AGENTS.md" })
    expect(card?.content).toBeUndefined()
    expect(ViewState.isCardExpandable(card!)).toBe(false)

    const toggled = ViewState.toggleCard(state, "read_agents")
    expect(toggled.expanded_ids.has("read_agents")).toBe(false)
  })

  test("search and command rows keep useful expandable output", () => {
    const state = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace/rika",
      mode: "smart",
      events: [
        toolRequested(1, "search_structured_output", "semantic_search", { query: "structured output" }),
        toolCompleted(2, "search_structured_output", "semantic_search", {
          results: [{ path: "packages/llm/src/openai.ts", line: 12, text: "OpenAI structured output" }],
        }),
        toolRequested(3, "run_tests", "bash", { command: "bun test packages/tui" }),
        toolCompleted(4, "run_tests", "bash", { stdout: "56 pass\n", stderr: "", exit_code: 0 }),
      ],
    })

    const search = state.cards.find((candidate) => candidate.id === "search_structured_output")
    expect(search).toMatchObject({ title: "Search structured output", status: "success" })
    expect(ViewState.isCardExpandable(search!)).toBe(true)
    expect(search?.content).toMatchObject({ kind: "text" })
    expect(search?.content?.kind === "text" ? search.content.text : "").toContain("packages/llm/src/openai.ts")

    const command = state.cards.find((candidate) => candidate.id === "run_tests")
    expect(command).toMatchObject({ title: "$ bun test packages/tui", status: "success" })
    expect(ViewState.isCardExpandable(command!)).toBe(true)
    expect(command?.content).toMatchObject({ kind: "text" })
    expect(command?.content?.kind === "text" ? command.content.text : "").toContain("56 pass")
  })

  test("edit rows own their Pierre diff expansion", () => {
    const state = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace/rika",
      mode: "smart",
      events: [
        toolRequested(1, "edit_file", "edit", { path: "packages/app.ts" }),
        toolCompleted(2, "edit_file", "edit", {
          type: "hashline.edit",
          path: "packages/app.ts",
          diff: pierreDiff("packages/app.ts"),
        }),
      ],
    })

    const card = state.cards.find((candidate) => candidate.id === "edit_file")
    expect(state.cards.some((candidate) => candidate.kind === "diff")).toBe(false)
    expect(card).toMatchObject({ title: "Edited packages/app.ts +1 -1", status: "success", path: "packages/app.ts" })
    expect(ViewState.isCardExpandable(card!)).toBe(true)
    expect(card?.content).toMatchObject({ kind: "pierre-diff", file_diff: { name: "packages/app.ts" } })
  })

  test("tool paths inside the workspace are shown as relative navigation targets", () => {
    const state = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace/rika",
      mode: "smart",
      events: [
        toolRequested(1, "read_absolute", "read", {
          path: "/workspace/rika/packages/tui/src/adapter.ts",
          start_line: 7,
          end_line: 9,
        }),
        toolCompleted(2, "read_absolute", "read", {
          path: "/workspace/rika/packages/tui/src/adapter.ts",
          start_line: 7,
          end_line: 9,
          content: "hidden",
        }),
      ],
    })

    expect(state.cards.find((candidate) => candidate.id === "read_absolute")).toMatchObject({
      title: "Read packages/tui/src/adapter.ts",
      path: "packages/tui/src/adapter.ts",
      range: { start_line: 7, end_line: 9 },
    })
  })
})

describe("ViewState palette", () => {
  test("open/insert/move/close keep palette_open mirrored", () => {
    let state = ViewState.openPalette(base())
    expect(state.palette.open).toBe(true)
    expect(state.palette_open).toBe(true)
    state = ViewState.paletteInsert(state, "m")
    expect(state.palette.query).toBe("m")
    state = ViewState.paletteMove(state, 1, 3)
    expect(state.palette.selected).toBe(1)
    state = ViewState.paletteMove(state, -2, 3)
    expect(state.palette.selected).toBe(2)
    state = ViewState.closePalette(state)
    expect(state.palette.open).toBe(false)
    expect(state.palette_open).toBe(false)
  })
})

describe("ViewState pickers", () => {
  test("file picker: acceptSelected inserts @<path>", () => {
    let state = ViewState.openFilePicker(base(), ["a.ts", "b.ts"])
    expect(state.filepicker.kind).toBe("file")
    state = ViewState.acceptSelected(state)
    expect(state.input.text).toBe("@a.ts ")
    expect(state.filepicker.open).toBe(false)
  })

  test("thread picker: openThreadPicker filters by label and acceptSelected inserts @<thread_id>", () => {
    let state = ViewState.openThreadPicker(base(), [
      { label: "thread_abc: hello", insert: "thread_abc" },
      { label: "thread_def: world", insert: "thread_def" },
    ])
    expect(state.filepicker.kind).toBe("thread")
    expect(ViewState.filteredFiles(state)).toEqual(["thread_abc: hello", "thread_def: world"])
    state = ViewState.filePickerInsert(state, "world")
    expect(ViewState.filteredFiles(state)).toEqual(["thread_def: world"])
    state = ViewState.acceptSelected(state)
    expect(state.input.text).toBe("@thread_def ")
    expect(state.filepicker.open).toBe(false)
  })
})

const withCards = (): ViewState.ViewState =>
  ViewState.initial({
    thread_id: threadId,
    workspace_path: "/workspace/rika",
    mode: "smart",
    events: [
      toolRequested(1, "tool_a"),
      toolCompleted(2, "tool_a"),
      toolRequested(3, "tool_b"),
      toolCompleted(4, "tool_b"),
    ],
  })

const withInput = (text: string, cursor = text.length): ViewState.ViewState => ({
  ...base(),
  input: { text, cursor, attachments: [] },
})

const eventBase = (sequence: number): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_view_state_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  ...eventBase(sequence),
  turn_id: turnId,
  type: "turn.started",
  data: {},
})

const toolRequested = (
  sequence: number,
  id: string,
  name = "write",
  input: Common.JsonValue = { path: "a.ts" },
): Event.ToolCallRequested => ({
  ...eventBase(sequence),
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make(id), name, input } },
})

const toolCompleted = (
  sequence: number,
  id: string,
  name = "write",
  output: Common.JsonValue = { ok: true },
): Event.ToolCallCompleted => ({
  ...eventBase(sequence),
  type: "tool.call.completed",
  data: {
    result: { id: Ids.ToolCallId.make(id), name, status: "success", output },
  },
})

const turnCompletedWithUsage = (sequence: number, inputTokens: number): Event.TurnCompleted => ({
  ...eventBase(sequence),
  turn_id: turnId,
  type: "turn.completed",
  data: {
    provider: "openai",
    model: "gpt-5.5",
    usage: { input_tokens: inputTokens, output_tokens: 100, total_tokens: inputTokens + 100 },
  },
})

const messageAddedWithUser = (sequence: number, text: string, messageUserId: Ids.UserId): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_view_state_user_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_view_state_user_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role: "user",
      content: [Message.text(text)],
      created_at: Common.TimestampMillis.make(sequence),
      metadata: { user_id: messageUserId },
    },
  },
})

const contextPruned = (sequence: number): Event.ContextPruned => ({
  ...eventBase(sequence),
  type: "context.pruned",
  data: {
    tool_call_ids: [Ids.ToolCallId.make("tool_pruned_a"), Ids.ToolCallId.make("tool_pruned_b")],
    estimated_tokens_freed: 24_000,
  },
})

const pierreDiff = (name: string): Common.JsonValue => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  collapsed: true,
  file_diff: {
    name,
    type: "change",
    isPartial: false,
    deletionLines: ["const value = 1\n", "console.log(value)\n"],
    additionLines: ["const value = 1\n", "console.info(value)\n"],
    hunks: [
      {
        hunkSpecs: "@@ -1,2 +1,2 @@\n",
        deletionStart: 1,
        deletionCount: 2,
        deletionLineIndex: 0,
        deletionLines: 2,
        additionStart: 1,
        additionCount: 2,
        additionLineIndex: 0,
        additionLines: 2,
        hunkContent: [
          { type: "context", deletionLineIndex: 0, additionLineIndex: 0, lines: 1 },
          { type: "change", deletionLineIndex: 1, deletions: 1, additionLineIndex: 1, additions: 1 },
        ],
      },
    ],
  },
})
