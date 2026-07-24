import { describe, expect, test } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { Keys, Palette, ViewState } from "../src"

const key = (input: Partial<Keys.Key> & Pick<Keys.Key, "name">): Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

const thread = (
  input: Partial<ViewState.ThreadItem> & Pick<ViewState.ThreadItem, "id" | "title">,
): ViewState.ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

const readCall = (
  id: string,
  detail: string,
  status: "running" | "complete" = "running",
): Extract<ViewState.TranscriptBlock, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id,
  name: "read",
  input: detail,
  status,
  presentation: {
    family: "explore",
    action: "read",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "file",
  },
  detail,
  files: [],
})

const editFile = (id: string, path: string) => ({
  key: id,
  path,
  kind: "update" as const,
  patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  preview: false,
  status: "complete" as const,
})

const busyQueueModel = (model: ViewState.Model): ViewState.Model => ({
  ...model,
  busy: true,
  currentThreadId: "t",
})

describe("ViewState", () => {
  test("cycles cost, tokens, and active time", () => {
    expect(ViewState.nextUsageDisplay("cost")).toBe("tokens")
    expect(ViewState.nextUsageDisplay("tokens")).toBe("time")
    expect(ViewState.nextUsageDisplay("time")).toBe("cost")
  })

  test.each([
    [Duration.zero, "◷ 0s"],
    [Duration.seconds(43), "◷ 43s"],
    [Duration.sum(Duration.minutes(1), Duration.seconds(43)), "◷ 1m 43s"],
    [Duration.sum(Duration.hours(1), Duration.minutes(43)), "◷ 1h 43m"],
    [Duration.sum(Duration.days(1), Duration.hours(2)), "◷ 1d 2h"],
    [Duration.sum(Duration.days(1), Duration.minutes(43)), "◷ 1d"],
  ])("formats active time as at most two adjacent units", (duration, expected) => {
    expect(ViewState.formatActiveTime(duration)).toBe(expected)
  })

  test("adds only an open active interval to accumulated time", () => {
    expect(
      ViewState.activeTimeAt({ _tag: "Available", accumulatedMillis: 5_000, activeSince: 10_000 }, 53_000),
    ).toEqual(Duration.seconds(48))
    expect(ViewState.activeTimeAt({ _tag: "Available", accumulatedMillis: 5_000 }, 53_000)).toEqual(Duration.seconds(5))
  })

  test("tracks only the five turn activity states", () => {
    let model = { ...ViewState.initial("/work", "medium"), input: "run it", cursor: 6 }
    model = ViewState.update(model, { _tag: "Submitted" })
    expect(model.activity).toEqual({ _tag: "Sending" })
    expect(ViewState.formatActivity(model.activity)).toBe("Sending")

    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "turn", prompt: "run it" })
    expect(ViewState.formatActivity(model.activity)).toBe("Waiting")

    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "12345678🙂" })
    expect(ViewState.formatActivity(model.activity)).toBe("Thinking 3 tok")
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "abcd" })
    expect(ViewState.formatActivity(model.activity)).toBe("Thinking 4 tok")
    model = ViewState.update(model, { _tag: "AssistantStreamed", text: "abcdefgh", turnId: "turn" })
    expect(ViewState.formatActivity(model.activity)).toBe("Streaming 2 tok")
    model = ViewState.update(model, { _tag: "AssistantCompleted", text: "abcdefgh", turnId: "turn" })
    expect(ViewState.formatActivity(model.activity)).toBe("Waiting")
    expect(ViewState.formatActivity({ _tag: "Compacting" })).toBe("Auto-Compacting")

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) })
    expect(ViewState.formatActivity(model.activity)).toBe("Waiting")
  })

  test("formats Amp activity counters with the singular tok unit", () => {
    expect(ViewState.formatActivity({ _tag: "Thinking", bytes: 0 })).toBe("Thinking 0 tok")
    expect(ViewState.formatActivityCounter(1)).toBe("1 tok")
    expect(ViewState.formatActivityCounter(999)).toBe("999 tok")
    expect(ViewState.formatActivityCounter(1_234)).toBe("1.23k tok")
    expect(ViewState.formatActivityCounter(12_345)).toBe("12.3k tok")
    expect(ViewState.formatActivityCounter(1_234_567)).toBe("1.2M tok")
  })

  test("summarizes top-level subagents separately from all other running tools", () => {
    const rootAgent = {
      ...readCall("root-agent", "Root agent"),
      presentation: {
        family: "agent" as const,
        action: "task",
        activeLabel: "Subagent working",
        completeLabel: "Subagent finished",
      },
    }
    const nestedAgent = { ...rootAgent, id: "nested-agent" }
    const blocks = [rootAgent, nestedAgent, readCall("root-read", "a.ts"), readCall("nested-read", "b.ts")]
    const activity = ViewState.runningToolsActivity({
      ...ViewState.initial("/work"),
      blocks,
      items: [
        { _tag: "Block", index: 0, id: "tool:root-agent" },
        { _tag: "Block", index: 1, id: "tool:nested-agent", parentId: "root-agent" },
        { _tag: "Block", index: 2, id: "tool:root-read" },
        { _tag: "Block", index: 3, id: "tool:nested-read", parentId: "nested-agent" },
      ],
    })

    expect(activity).toEqual({ _tag: "RunningTools", subagents: 1, tools: 2 })
    expect(ViewState.formatActivity(activity)).toBe("Running 1 subagent, 2 tools")
    expect(ViewState.formatActivity({ _tag: "RunningTools", subagents: 5, tools: 3 })).toBe(
      "Running 5 subagents, 3 tools",
    )
  })

  test("exposes only thread switch, mode change, fast mode, and quit in the command palette", () => {
    expect(Palette.commands).toEqual([
      {
        id: "threads",
        category: "thread",
        label: "switch",
        keybinding: "Ctrl+T",
        action: { _tag: "SwitchThread" },
      },
      {
        id: "mode",
        category: "mode",
        label: "change mode",
        keybinding: "Ctrl+S",
        action: { _tag: "OpenModePicker" },
      },
      { id: "fast-mode", category: "rika", label: "toggle fast mode", action: { _tag: "ToggleFastMode" } },
      {
        id: "quit",
        category: "rika",
        label: "quit",
        keybinding: "Ctrl+C",
        action: { _tag: "Quit" },
      },
    ])
    expect(Palette.filter("review")).toEqual([])
    expect(Palette.filter("reasoning")).toEqual([])
    expect(Palette.filter("changed files")).toEqual([])
  })

  it.effect("completes file mentions and exposes mode and shortcuts state", () =>
    Effect.sync(() => {
      let model = ViewState.update(ViewState.initial("/work", "medium"), {
        _tag: "FilesReplaced",
        files: ["src/main.ts", "docs/SPEC.md"],
      })
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
      model = { ...model, filePicker: { ...model.filePicker, query: "main" } }
      expect(ViewState.filteredFiles(model)).toEqual(["src/main.ts"])
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
      expect(model.input).toBe("@src/main.ts ")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) })
      expect(model.modePicker).toEqual({ open: true, selected: 1 })
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) })
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
      expect(model.mode).toBe("high")
      model = { ...model, input: "", cursor: 0 }
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "?", sequence: "?" }) })
      expect(model.shortcutsOpen).toBe(true)
      expect(model.input).toBe("?")
    }),
  )

  test("leaves Opt+D unbound", () => {
    const model = ViewState.initial("/work", "medium")
    expect(ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "d", alt: true }) })).toEqual(model)
  })

  test("preserves ordered prompt parts for bracketed paths and file URLs", () => {
    expect(ViewState.promptParts("before [shots/a.png] after file:///tmp/b%20c.webp")).toEqual([
      { type: "text", text: "before " },
      { type: "image", path: "shots/a.png" },
      { type: "text", text: " after " },
      { type: "image", path: "/tmp/b c.webp" },
    ])
    expect(ViewState.promptParts("inspect /tmp/dropped\\ image.png now")).toEqual([
      { type: "text", text: "inspect " },
      { type: "image", path: "/tmp/dropped image.png" },
      { type: "text", text: " now" },
    ])
  })

  test("edits, moves, and submits input", () => {
    let model = ViewState.initial("/work")
    expect(ViewState.update(model, { _tag: "Submitted" })).toBe(model)
    expect(ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })).toBe(model)
    expect(ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })).toBe(model)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "h", sequence: "h" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "i", sequence: "i" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "left" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "right" }) })
    expect(model.input).toBe("xi")
    model = ViewState.update(model, { _tag: "Submitted" })
    expect(model.entries).toEqual([])
    expect(model.busy).toBe(true)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "q", sequence: "q" }) })
    model = ViewState.update(model, { _tag: "Submitted" })
    expect(model.entries).toEqual([])
    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "q", prompt: "q" })
    expect(model.entries.at(-1)).toEqual({ role: "user", text: "q", turnId: "q" })
    expect(model.busy).toBe(true)
  })

  test("classifies shell prompts and keeps incognito commands out of prompt semantics", () => {
    expect(ViewState.classifyPrompt("$ echo ok")).toEqual({ _tag: "Shell", command: "echo ok", incognito: false })
    expect(ViewState.classifyPrompt("$$ secret")).toEqual({ _tag: "Shell", command: "secret", incognito: true })
    expect(ViewState.classifyPrompt("explain $PATH")).toEqual({ _tag: "Prompt", prompt: "explain $PATH" })
  })

  test("replaces the visible prompt for an existing Turn without changing execution state", () => {
    const started = ViewState.update(ViewState.initial("/work"), {
      _tag: "TurnStarted",
      turnId: "queued",
      prompt: "before",
    })
    const model = ViewState.replaceTurnPrompt({ ...started, busy: false, activeTurnId: undefined }, "queued", "after")
    expect(model.entries).toEqual([{ role: "user", text: "after", turnId: "queued" }])
    expect(model.busy).toBe(false)
    expect(model.activeTurnId).toBeUndefined()
    const promoted = ViewState.update(model, { _tag: "TurnStarted", turnId: "queued", prompt: "after" })
    expect(promoted.entries).toEqual([{ role: "user", text: "after", turnId: "queued" }])
    expect(promoted.busy).toBe(true)
  })

  test("applies revisioned queue deltas and requests a resync on gaps or invalid changes", () => {
    let model = ViewState.resetQueue({ ...ViewState.initial("/work"), currentThreadId: "thread" }, "thread", 3, [
      { id: "one", prompt: "one" },
    ])
    let applied = ViewState.applyQueueDelta(model, "thread", 4, {
      _tag: "Added",
      item: { id: "two", prompt: "two" },
    })
    expect(applied.resync).toBe(false)
    expect(applied.model.queue.map((item) => item.id)).toEqual(["one", "two"])
    model = { ...applied.model, queueSelection: "two" }

    applied = ViewState.applyQueueDelta(model, "thread", 4, {
      _tag: "Added",
      item: { id: "two", prompt: "duplicate" },
    })
    expect(applied).toEqual({ model, resync: false })

    expect(ViewState.applyQueueDelta(model, "thread", 6, { _tag: "Removed", turnId: "one" }).resync).toBe(true)
    expect(ViewState.applyQueueDelta(model, "other", 5, { _tag: "Removed", turnId: "one" }).resync).toBe(false)

    applied = ViewState.applyQueueDelta(model, "thread", 5, {
      _tag: "Updated",
      item: { id: "two", prompt: "edited" },
    })
    expect(applied.model.queue[1]?.prompt).toBe("edited")
    applied = ViewState.applyQueueDelta(applied.model, "thread", 6, { _tag: "Removed", turnId: "two" })
    expect(applied.resync).toBe(false)
    expect(applied.model.queue).toEqual([{ id: "one", prompt: "one" }])
    expect(applied.model.queueSelection).toBe("one")
  })

  test("supports multiline, palette, release, and resize messages", () => {
    let model = ViewState.initial("/work", "high")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return", shift: true }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "linefeed" }) })
    expect(model.input).toBe("\n\n")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    expect(model.paletteOpen).toBe(true)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.paletteOpen).toBe(false)
    expect(
      ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x", eventType: "release" }) }),
    ).toEqual(model)
    model = ViewState.update(model, { _tag: "Resized", width: 50, height: 12 })
    expect([model.width, model.height]).toEqual([50, 12])
    expect(ViewState.isNarrow(model)).toBe(true)
  })

  test("reduces a resize storm to the final size", () => {
    let model = ViewState.initial("/work", "high")
    for (const [width, height] of [
      [100, 40],
      [90, 30],
      [70, 20],
      [132, 43],
    ] as const)
      model = ViewState.update(model, { _tag: "Resized", width, height })
    expect([model.width, model.height]).toEqual([132, 43])
  })

  test("grows multiline input and supports newline shortcuts and history search", () => {
    let model = ViewState.initial("/work")
    for (const character of "first")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "Submitted" })
    model = { ...model, input: "second", cursor: 6 }
    model = ViewState.update(model, { _tag: "Submitted" })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.input).toBe("second")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.input).toBe("first")
    model = { ...model, input: "cond", cursor: 4 }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
    expect(model.input).toBe("second")
    model = { ...model, input: "a\\", cursor: 2 }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "j", ctrl: true }) })
    expect(model.input).toBe("a\n\n")
    expect(ViewState.inputRows(model)).toBe(3)
  })

  test("auto-grows and manually resizes the composer within terminal bounds", () => {
    let model = { ...ViewState.initial("/work"), input: "one\ntwo\nthree\nfour", cursor: 18 }
    expect(ViewState.composerHeight(model)).toBe(6)
    model = ViewState.update(model, { _tag: "ComposerHeightChanged", height: 12 })
    expect(ViewState.composerHeight(model)).toBe(12)
    model = ViewState.update(model, { _tag: "ComposerHeightChanged", height: 2 })
    expect(ViewState.composerHeight(model)).toBe(6)
    model = ViewState.update(model, { _tag: "ComposerHeightChanged", height: 20 })
    model = ViewState.update(model, { _tag: "Resized", width: 80, height: 10 })
    expect(model.composerHeight).toBe(6)
    expect(ViewState.composerHeight(model)).toBe(6)
  })

  test("counts composer rows by terminal cell width for wide, combining, and sidebar-narrowed input", () => {
    const cjk = { ...ViewState.initial("/work", "high"), width: 40, input: "文".repeat(40) }
    expect(ViewState.inputRows(cjk)).toBe(3)

    const combining = { ...ViewState.initial("/work", "high"), width: 12, input: "e\u0301".repeat(8) }
    expect(ViewState.inputRows(combining)).toBe(1)

    expect(ViewState.wrappedRowCount("👩‍💻", 3)).toBe(1)

    const sidebar = {
      ...ViewState.initial("/work", "high"),
      width: 100,
      changedFilesOpen: true,
      changedFiles: ViewState.ready([{ path: "a.ts", status: "M" }]),
      sidebarWidth: 40,
      input: "x".repeat(70),
    }
    expect(ViewState.inputRows(sidebar)).toBe(2)
    expect(ViewState.inputRows({ ...sidebar, changedFilesOpen: false })).toBe(1)
  })

  test("keeps queue state outside the transcript and tracks reasoning and scroll follow", () => {
    let model = ViewState.replaceQueue(ViewState.initial("/work"), [{ id: "queued", prompt: "old" }])
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "details" })
    model = ViewState.update(model, { _tag: "ReasoningToggled", index: 0 })
    expect(model.blocks).toEqual([{ _tag: "Reasoning", text: "details" }])
    expect(model.expandedRowKeys).toEqual(["block:Reasoning:0"])
    expect(model.queue).toEqual([{ id: "queued", prompt: "old" }])
    model = ViewState.update(model, { _tag: "ScrollMoved", offset: 4 })
    expect(model.scrollFollow).toBe(false)
    model = ViewState.update(model, { _tag: "ScrollFollowed" })
    expect(model).toMatchObject({ scrollFollow: true, scrollOffset: 0 })
  })

  test("leaves transcript navigation keys to the viewport owner", () => {
    let model: ViewState.Model = {
      ...ViewState.initial("/work"),
      height: 24,
      entries: Array.from({ length: 80 }, (_, index) => ({ role: "assistant" as const, text: `line ${index}` })),
      scrollOffset: 120,
    }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "pageup" }) })
    expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
    model = ViewState.update(model, { _tag: "AssistantStreamed", text: "more" })
    expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "pagedown" }) })
    expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "end" }) })
    expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  })

  test("streams, completes, and reports failures", () => {
    let model = ViewState.initial("/work")
    model = ViewState.update(model, { _tag: "AssistantStreamed", text: "hel" })
    model = ViewState.update(model, { _tag: "AssistantStreamed", text: "lo" })
    expect(model.entries).toEqual([{ role: "assistant", text: "hello" }])
    model = ViewState.update(model, { _tag: "AssistantCompleted", text: "final" })
    expect(model.entries).toEqual([{ role: "assistant", text: "final" }])
    model = ViewState.update(model, { _tag: "AssistantStreamed", text: "next" })
    model = ViewState.update(model, { _tag: "AssistantCompleted", text: "next final" })
    expect(model.entries).toEqual([
      { role: "assistant", text: "final" },
      { role: "assistant", text: "next final" },
    ])
    model = ViewState.update(model, { _tag: "AssistantCompleted", text: "completion only" })
    expect(model.entries.at(-1)).toEqual({ role: "assistant", text: "completion only" })
    expect(model.entries).toHaveLength(3)
    model = ViewState.update(model, { _tag: "ExecutionFailed", message: "failed" })
    expect(model.blocks.at(-1)).toEqual({
      _tag: "Error",
      title: "Message failed",
      detail: "failed",
      recovery: "Press Enter to try again.",
    })
    expect(model.items.at(-1)).toEqual({ _tag: "Block", index: 0 })
    expect(model.busy).toBe(false)
    model = { ...model, input: "try again", cursor: 9 }
    model = ViewState.update(model, { _tag: "Submitted" })
    expect(model.entries.at(-1)).toEqual({ role: "assistant", text: "completion only" })
    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "retry", prompt: "try again" })
    expect(model.entries.at(-1)).toEqual({ role: "user", text: "try again", turnId: "retry" })
    expect(model.items.at(-1)).toEqual({ _tag: "Entry", index: 3, id: "turn:retry:user", turnId: "retry" })
    expect(model).toMatchObject({ input: "", busy: true })
    model = ViewState.update(ViewState.initial("/work"), { _tag: "AssistantCompleted", text: "standalone" })
    expect(model.entries).toEqual([{ role: "assistant", text: "standalone" }])
  })

  test("cancels every running transcript unit once and leaves no global notice", () => {
    const parent = {
      _tag: "ToolCall" as const,
      id: "parent",
      name: "task",
      input: "{}",
      status: "running" as const,
      presentation: {
        family: "agent" as const,
        action: "task",
        activeLabel: "Subagent working",
        completeLabel: "Subagent finished",
      },
      detail: "Run the checks",
      files: [],
    }
    const child = readCall("child", "src/a.ts")
    const running: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn",
      blocks: [parent, child],
      items: [
        { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
        { _tag: "Block", index: 1, id: "tool:child", turnId: "turn:child", parentId: "parent" },
      ],
    }

    const cancelled = ViewState.update(running, { _tag: "ExecutionCancelled", turnId: "turn" })
    const repeated = ViewState.update(cancelled, { _tag: "ExecutionCancelled", turnId: "turn" })

    expect(cancelled.blocks).toEqual([
      expect.objectContaining({ id: "parent", status: "cancelled" }),
      expect.objectContaining({ id: "child", status: "cancelled" }),
    ])
    expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(repeated).toBe(cancelled)
  })

  test("restores a submitted draft when cancellation arrives before an agent response", () => {
    let running = ViewState.update(
      { ...ViewState.initial("/work"), input: "cancel this prompt", cursor: 6 },
      { _tag: "Submitted" },
    )
    const attachment = { type: "text" as const, token: "token", value: "attachment", label: "Pasted text #1" }
    running = ViewState.update(
      { ...running, pastedText: [attachment] },
      { _tag: "TurnStarted", turnId: "turn", prompt: "cancel this prompt" },
    )
    running = {
      ...running,
      submittedDrafts: [{ input: "cancel this prompt", cursor: 6, attachments: [attachment], turnId: "turn" }],
    }

    const cancelled = ViewState.update(running, {
      _tag: "ExecutionCancelled",
      turnId: "turn",
      agentResponseArrived: false,
    })
    const repeated = ViewState.update(cancelled, {
      _tag: "ExecutionCancelled",
      turnId: "turn",
      agentResponseArrived: false,
    })

    expect(cancelled).toMatchObject({
      input: "cancel this prompt",
      cursor: 6,
      pastedText: [attachment],
      busy: false,
      activeTurnId: undefined,
    })
    expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(repeated).toBe(cancelled)
  })

  test("submitting while a turn is active stays an ordinary submission", () => {
    const busy: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      input: "queued follow-up",
    }
    const submitted = ViewState.update(busy, { _tag: "Submitted", submissionId: "sub-q" })
    expect(submitted.input).toBe("")
    expect(submitted.busy).toBe(true)
    expect(submitted.pendingSteering).toEqual([])
    expect(submitted.pendingAction).toBeUndefined()
    expect(submitted.submittedDrafts).toEqual([
      { input: "queued follow-up", attachments: [], cursor: 0, submissionId: "sub-q" },
    ])
  })

  test("steering a selected queued message opens a pending steering row", () => {
    const busy: ViewState.Model = ViewState.resetQueue(
      {
        ...ViewState.initial("/work"),
        busy: true,
        activeTurnId: "turn-a",
        currentThreadId: "thread",
        queueSelection: "queued-1",
      },
      "thread",
      1,
      [{ id: "queued-1", prompt: "steer me please" }],
    )
    const steered = ViewState.update(busy, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(steered.pendingSteering).toEqual([{ turnId: "turn-a", text: "steer me please" }])
    expect(steered.pendingAction).toEqual({ _tag: "SteerQueued", id: "queued-1", prompt: "steer me please" })
  })

  test("binds an accepted steering sequence and removes it on delivery", () => {
    const busy: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      pendingSteering: [{ turnId: "turn-a", text: "focus on the fixture" }],
    }
    const accepted = ViewState.update(busy, {
      _tag: "SteeringAccepted",
      turnId: "turn-a",
      sequence: 0,
      text: "focus on the fixture",
    })
    expect(accepted.pendingSteering).toEqual([{ turnId: "turn-a", text: "focus on the fixture", sequence: 0 }])
    const delivered = ViewState.update(accepted, { _tag: "SteeringDelivered", turnId: "turn-a", sequences: [0] })
    expect(delivered.pendingSteering).toEqual([])
    const foreign = ViewState.update(accepted, { _tag: "SteeringDelivered", turnId: "turn-b", sequences: [0] })
    expect(foreign.pendingSteering).toHaveLength(1)
  })

  test("restores undelivered steering text into an empty composer when the turn settles", () => {
    const busy: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      pendingSteering: [{ turnId: "turn-a", text: "left behind", sequence: 0 }],
    }
    const completed = ViewState.update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
    expect(completed.pendingSteering).toEqual([])
    expect(completed.input).toBe("left behind")
    const occupied = ViewState.update({ ...busy, input: "typing" }, { _tag: "ExecutionCompleted", turnId: "turn-a" })
    expect(occupied.pendingSteering).toEqual([])
    expect(occupied.input).toBe("typing")
  })

  test("keeps steering rows for other turns when one turn settles", () => {
    const busy: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      pendingSteering: [
        { turnId: "turn-a", text: "for a", sequence: 0 },
        { turnId: "turn-b", text: "for b", sequence: 1 },
      ],
    }
    const completed = ViewState.update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
    expect(completed.pendingSteering).toEqual([{ turnId: "turn-b", text: "for b", sequence: 1 }])
  })

  test("binds keyed submission drafts and restores only the cancelled turn's draft", () => {
    let model = ViewState.update(
      { ...ViewState.initial("/work"), input: "first prompt" },
      { _tag: "Submitted", submissionId: "sub-a" },
    )
    model = { ...model, busy: false, activity: undefined }
    model = ViewState.update({ ...model, input: "second prompt" }, { _tag: "Submitted", submissionId: "sub-b" })
    model = ViewState.update(model, { _tag: "SubmissionAdmitted", turnId: "turn-a", submissionId: "sub-a" })
    model = ViewState.update(model, { _tag: "SubmissionAdmitted", turnId: "turn-b", submissionId: "sub-b" })
    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "turn-a", prompt: "first prompt" })
    expect(model.submittedDrafts).toEqual([
      { input: "first prompt", attachments: [], cursor: 0, submissionId: "sub-a", turnId: "turn-a" },
      { input: "second prompt", attachments: [], cursor: 0, submissionId: "sub-b", turnId: "turn-b" },
    ])
    const cancelled = ViewState.update(model, {
      _tag: "ExecutionCancelled",
      turnId: "turn-a",
      agentResponseArrived: false,
    })
    expect(cancelled.input).toBe("first prompt")
    expect(cancelled.submittedDrafts).toEqual([
      { input: "second prompt", attachments: [], cursor: 0, submissionId: "sub-b", turnId: "turn-b" },
    ])
  })

  test("a stale terminal event for another turn does not clear the active turn", () => {
    const busy: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn-b",
      submittedDrafts: [{ input: "second", attachments: [], cursor: 0, turnId: "turn-b" }],
    }
    const afterStale = ViewState.update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
    expect(afterStale.busy).toBe(true)
    expect(afterStale.activeTurnId).toBe("turn-b")
    expect(afterStale.submittedDrafts).toHaveLength(1)
  })

  test("keeps a cancellation marker after an agent response when no transcript unit can carry it", () => {
    const running: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn",
      submittedDrafts: [{ input: "submitted", cursor: 9, attachments: [], turnId: "turn" }],
    }

    const cancelled = ViewState.update(running, {
      _tag: "ExecutionCancelled",
      turnId: "turn",
      agentResponseArrived: true,
    })

    expect(cancelled.entries).toEqual([{ role: "notice", text: "cancelled", turnId: "turn" }])
    expect(cancelled.items).toEqual([{ _tag: "Entry", index: 0, id: "execution:turn:cancelled", turnId: "turn" }])
    expect(cancelled.input).toBe("")
  })

  test("does not add a fallback marker when the parent cancellation event arrived first", () => {
    const parent = {
      _tag: "ToolCall" as const,
      id: "parent",
      name: "task",
      input: "{}",
      status: "cancelled" as const,
      presentation: {
        family: "agent" as const,
        action: "task",
        activeLabel: "Subagent working",
        completeLabel: "Subagent finished",
      },
      detail: "Run the checks",
      files: [],
    }
    const child = readCall("child", "src/a.ts")
    const running: ViewState.Model = {
      ...ViewState.initial("/work"),
      busy: true,
      activeTurnId: "turn",
      blocks: [parent, child],
    }

    const cancelled = ViewState.update(running, { _tag: "ExecutionCancelled", turnId: "turn" })

    expect(cancelled.blocks).toEqual([
      expect.objectContaining({ id: "parent", status: "cancelled" }),
      expect.objectContaining({ id: "child", status: "cancelled" }),
    ])
    expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
  })

  test("models structured transcript blocks without backend types", () => {
    let model = ViewState.initial("/work")
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "checking " })
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "files" })
    model = ViewState.update(model, {
      _tag: "BlockAdded",
      block: {
        _tag: "ToolCall",
        id: "1",
        name: "read",
        input: "a.ts",
        status: "running",
        presentation: {
          family: "explore",
          action: "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: "file",
        },
        detail: "a.ts",
        files: [],
      },
    })
    model = ViewState.update(model, {
      _tag: "BlockAdded",
      block: { _tag: "ToolResult", id: "1", output: "ok", failed: false },
    })
    model = ViewState.update(model, { _tag: "BlockAdded", block: { _tag: "Diff", path: "a.ts", patch: "+hello" } })
    model = ViewState.update(model, {
      _tag: "BlockAdded",
      block: { _tag: "Permission", id: "2", kind: "tool-approval", title: "Write", detail: "a.ts", status: "pending" },
    })
    expect(model.blocks).toHaveLength(5)
    expect(model.blocks[0]).toMatchObject({ _tag: "Reasoning", text: "checking files" })
  })

  test("executes every focused palette action", () => {
    let model = ViewState.initial("/work")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    for (const character of "change mode")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.modePicker.open).toBe(true)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.mode).toBe("high")

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    for (const character of "thread switch")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.threadSwitcher.open).toBe(true)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    for (const character of "fast")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.fastMode).toBe(true)

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    for (const character of "quit")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({ _tag: "Quit" })
  })

  test("keeps overlays exclusive and types @ and ? into a non-empty composer", () => {
    let model = { ...ViewState.initial("/work"), input: "draft", cursor: 5 }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    expect(model).toMatchObject({ paletteOpen: false, palette: { open: false }, filePicker: { open: true } })
    expect(model.input).toBe("draft@")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
    expect(model).toMatchObject({ shortcutsOpen: false, filePicker: { open: true, query: "?" } })
    expect(model.input).toBe("draft@?")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.filePicker.open).toBe(false)
    expect(model.input).toBe("draft@?")
    model = { ...model, input: "", cursor: 0 }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
    expect(model.shortcutsOpen).toBe(true)
    expect(model.input).toBe("?")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.shortcutsOpen).toBe(false)
  })

  test("opens shortcuts only for the first question mark in an empty composer", () => {
    let sentence = { ...ViewState.initial("/work"), input: "how was your day", cursor: 16 }
    sentence = ViewState.update(sentence, {
      _tag: "KeyPressed",
      key: key({ name: "/", sequence: "?", shift: true }),
    })
    expect(sentence).toMatchObject({
      input: "how was your day?",
      cursor: 17,
      shortcutsOpen: false,
      shortcutsTrigger: undefined,
    })

    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "KeyPressed",
      key: key({ name: "/", sequence: "?", shift: true }),
    })
    expect(model).toMatchObject({ input: "?", cursor: 1, shortcutsOpen: true, shortcutsTrigger: 0 })

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "a", sequence: "a" }) })
    expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: true, shortcutsTrigger: 0 })

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
    expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: false, shortcutsTrigger: undefined })

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
    expect(model).toMatchObject({ input: "?a?", cursor: 3, shortcutsOpen: false, shortcutsTrigger: undefined })

    model = ViewState.update(ViewState.initial("/work"), {
      _tag: "KeyPressed",
      key: key({ name: "/", sequence: "?", shift: true }),
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    expect(model).toMatchObject({ input: "", cursor: 0, shortcutsOpen: false, shortcutsTrigger: undefined })
  })

  test("does not open shortcuts when question mark is typed in a dialog", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "KeyPressed",
      key: key({ name: "o", ctrl: true }),
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
    expect(model).toMatchObject({ shortcutsOpen: false, palette: { open: true, query: "?" }, input: "" })

    model = {
      ...ViewState.initial("/work"),
      blocks: [
        {
          _tag: "Permission",
          id: "permission",
          kind: "tool-approval",
          status: "pending",
          title: "Run command",
          detail: "bun test",
        },
      ],
    } as ViewState.Model
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
    expect(model).toMatchObject({ shortcutsOpen: false, input: "" })
  })

  test("keeps an empty palette open with a valid selection and no action", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "KeyPressed",
      key: key({ name: "o", ctrl: true }),
    })
    for (const character of "no such command")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    expect(model.palette.selected).toBe(0)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model).toMatchObject({ paletteOpen: true, palette: { open: true, selected: 0 } })
    expect(model.pendingAction).toBeUndefined()
  })

  test("switches mutually exclusively between the workspace file tree and changed files", () => {
    let model = ViewState.initial("/work")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
    expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "s", alt: true }) })
    expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: true })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
    expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
    expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: false })
  })

  test("toggles every transcript detail as one reducer action", () => {
    let model = {
      ...ViewState.initial("/work"),
      blocks: [
        { _tag: "Reasoning", text: "why" },
        readCall("read", "src/a.ts", "complete"),
        { _tag: "Diff", path: "src/a.ts", patch: "+a" },
      ],
    } as ViewState.Model
    model = ViewState.update(model, { _tag: "AllDetailsToggled" })
    expect(model.expandedRowKeys).toEqual(["block:Reasoning:0", "tool:read", "block:Diff:2"])
    model = ViewState.update(model, { _tag: "AllDetailsToggled" })
    expect(model.expandedRowKeys).toEqual([])
  })

  test("keeps an unchanged changed-files snapshot stable", () => {
    const files = [{ path: "src/a.ts", status: "M", added: 1, removed: 2 }]
    const model = ViewState.update(ViewState.initial("/work"), { _tag: "ChangedFilesReplaced", files })

    expect(ViewState.update(model, { _tag: "ChangedFilesReplaced", files: [...files] })).toBe(model)
  })

  test("selects permission decisions and executes the pending choice from keys", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "BlockAdded",
      block: { _tag: "Permission", id: "p", kind: "tool-approval", title: "Write", detail: "a.ts", status: "pending" },
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "right" }) })
    expect(model.permissionSelection).toBe(1)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({
      _tag: "DecidePermission",
      id: "p",
      kind: "tool-approval",
      decision: "always",
    })
    expect(model.blocks[0]).toMatchObject({ status: "approved" })
  })

  test("cancels only the matching permission and clears its stale action", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "BlockAdded",
      block: { _tag: "Permission", id: "old", kind: "permission", title: "Old", detail: "old", status: "pending" },
    })
    model = ViewState.update(model, {
      _tag: "BlockAdded",
      block: { _tag: "Permission", id: "new", kind: "permission", title: "New", detail: "new", status: "pending" },
    })
    model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "old" })
    model = ViewState.update(model, { _tag: "PermissionCancelled", id: "old" })

    expect(model.blocks).toMatchObject([
      { id: "old", status: "denied" },
      { id: "new", status: "pending" },
    ])
    expect(model.pendingAction).toBeUndefined()
    expect(model.permissionSelection).toBe(0)
  })

  test("moves up into queued turns and down or Escape back to the composer", () => {
    let model = ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
      { id: "one", prompt: "one" },
      { id: "two", prompt: "two" },
    ])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.queueSelection).toBe("two")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.queueSelection).toBe("one")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    expect(model.queueSelection).toBe("two")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    expect(model.queueSelection).toBeUndefined()
    expect(model.pendingAction).toBeUndefined()
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.queueSelection).toBe("two")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.queueSelection).toBeUndefined()
    expect(model.pendingAction).toBeUndefined()
  })

  test("steers and dequeues only while a queued turn is selected", () => {
    let model = ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
      { id: "one", prompt: "one" },
      { id: "two", prompt: "two" },
    ])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "two", prompt: "two" })
    model = { ...model, pendingAction: undefined }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "two" })
  })

  test("leaves the queue unchanged when Backspace is pressed from the composer", () => {
    const model = ViewState.update(
      ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
        { id: "first", prompt: "first" },
        { id: "second", prompt: "second" },
      ]),
      { _tag: "KeyPressed", key: key({ name: "backspace" }) },
    )
    expect(model.queueSelection).toBeUndefined()
    expect(model.pendingAction).toBeUndefined()
  })

  test("keeps queue navigation inactive on reset and Added", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
      { id: "a", prompt: "a" },
      { id: "b", prompt: "b" },
    ])
    expect(model.queueSelection).toBeUndefined()
    const added = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "c", prompt: "c" } })
    expect(added.resync).toBe(false)
    expect(added.model.queueSelection).toBeUndefined()
  })

  test("keeps a still-valid selection across reset and Updated", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
      { id: "a", prompt: "a" },
      { id: "b", prompt: "b" },
    ])
    model = { ...model, queueSelection: "a" }
    model = ViewState.resetQueue(model, "t", 2, [
      { id: "a", prompt: "a" },
      { id: "b", prompt: "b" },
    ])
    expect(model.queueSelection).toBe("a")
    const updated = ViewState.applyQueueDelta(model, "t", 3, { _tag: "Updated", item: { id: "a", prompt: "a3" } })
    expect(updated.model.queueSelection).toBe("a")
    expect(updated.model.queue[0]).toEqual({ id: "a", prompt: "a3" })
  })

  test("reselects the neighbor at the same index when the selected queued turn is removed", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
      { id: "a", prompt: "a" },
      { id: "b", prompt: "b" },
      { id: "c", prompt: "c" },
    ])
    model = { ...model, queueSelection: "b" }
    const removed = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Removed", turnId: "b" })
    expect(removed.model.queue.map((item) => item.id)).toEqual(["a", "c"])
    expect(removed.model.queueSelection).toBe("c")
  })

  test("reconciles a mismatched durable queued count by requesting a resync", () => {
    const model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "a" }])
    const applied = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "b", prompt: "b" } }, 5)
    expect(applied.resync).toBe(true)
  })

  test("edits a queued turn: Ctrl+E loads it, Enter saves EditQueued, Escape restores", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
      { id: "a", prompt: "alpha" },
      { id: "b", prompt: "beta" },
    ])
    expect(model.queueSelection).toBeUndefined()
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.queueSelection).toBe("b")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
    expect(model.editingTurnId).toBe("b")
    expect(model.input).toBe("beta")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "!", sequence: "!" }) })
    expect(model.input).toBe("beta!")
    const saved = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(saved.pendingAction).toEqual({ _tag: "EditQueued", id: "b", prompt: "beta!" })
    expect(saved.editingTurnId).toBeUndefined()
    expect(saved.input).toBe("")
    const cancelled = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(cancelled.editingTurnId).toBeUndefined()
    expect(cancelled.queueSelection).toBeUndefined()
    expect(cancelled.input).toBe("")
    expect(cancelled.pendingAction).toBeUndefined()
  })

  test("Enter on a selected queued row without edit mode still steers", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "a", prompt: "alpha" })
    expect(model.editingTurnId).toBeUndefined()
  })

  test("does not allow submit while editing a queued turn", () => {
    expect(ViewState.canSubmit({ ...ViewState.initial("/work"), editingTurnId: "b", input: "edited" })).toBe(false)
    expect(ViewState.canSubmit({ ...ViewState.initial("/work"), input: "normal" })).toBe(true)
  })

  test("exits edit mode and restores the composer when the edited queued turn is removed", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
      { id: "a", prompt: "alpha" },
      { id: "b", prompt: "beta" },
    ])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
    expect(model.editingTurnId).toBe("b")
    expect(model.input).toBe("beta")
    const removed = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Removed", turnId: "b" }).model
    expect(removed.editingTurnId).toBeUndefined()
    expect(removed.editReturn).toBeUndefined()
    expect(removed.input).toBe("")
  })

  test("blocks image attachment while editing a queued turn", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
    expect(model.editingTurnId).toBe("a")
    const after = ViewState.update(model, { _tag: "ImageInserted", path: "/tmp/x.png" })
    expect(after.input).toBe(model.input)
    expect(after.pastedText).toEqual([])
  })

  test("ignores queue dequeue and edit re-entry keys while editing with a cleared composer", () => {
    let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
    model = { ...model, input: "", cursor: 0 }
    const backspaced = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    expect(backspaced.pendingAction).toBeUndefined()
    expect(backspaced.editingTurnId).toBe("a")
    const reentry = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
    expect(reentry.input).toBe("")
  })

  test("navigates transcript detail units with Tab and toggles the selected unit", () => {
    let model = {
      ...ViewState.initial("/work"),
      blocks: [
        { _tag: "Reasoning", text: "why" },
        readCall("1", "a", "complete"),
        { _tag: "Diff", path: "a", patch: "+a" },
      ],
    } as ViewState.Model
    model = ViewState.update(
      { ...model, detailSelection: "block:Diff:2" },
      { _tag: "DetailToggled", id: "block:Diff:2" },
    )
    expect(model).toMatchObject({
      detailSelection: "block:Diff:2",
      expandedRowKeys: ["block:Diff:2"],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab", shift: true }) })
    expect(model.detailSelection).toBe("tool:1")
    model = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
    expect(model).toMatchObject({
      detailSelection: "tool:1",
      expandedRowKeys: ["block:Diff:2", "tool:1"],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
    expect(model.detailSelection).toBe("block:Diff:2")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
    expect(model.detailSelection).toBe("block:Reasoning:0")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.expandedRowKeys).toEqual(["block:Diff:2", "tool:1", "block:Reasoning:0"])
  })

  test("keeps an expanded streamed tool group open as new children arrive", () => {
    let model = ViewState.update(ViewState.initial("/work"), { _tag: "BlockAdded", block: readCall("1", "a") })
    model = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
    for (let index = 2; index <= 5; index += 1)
      model = ViewState.update(model, {
        _tag: "BlockAdded",
        block: readCall(String(index), String.fromCharCode(96 + index)),
      })

    expect(model.expandedRowKeys).toContain("tool:1")
    const collapsed = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
    expect(collapsed.expandedRowKeys).not.toContain("tool:1")
  })

  test("click toggles do not move the Tab detail selection", () => {
    const base = { ...ViewState.initial("/work"), blocks: [readCall("1", "a", "complete")] }
    const clicked = ViewState.update(base, { _tag: "DetailToggled", id: "tool:1" })
    expect(clicked).toMatchObject({ detailSelection: undefined, expandedRowKeys: ["tool:1"] })

    const tabbed = ViewState.update(clicked, { _tag: "KeyPressed", key: key({ name: "tab" }) })
    expect(tabbed.detailSelection).toBe("tool:1")
  })

  test("toggles an expanded edit group's file rows independently", () => {
    const call: Extract<ViewState.TranscriptBlock, { _tag: "ToolCall" }> = {
      _tag: "ToolCall",
      id: "patch",
      name: "edit",
      input: "{}",
      status: "complete",
      presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
      detail: "",
      files: [editFile("patch:0", "src/a.ts"), editFile("patch:1", "src/b.ts")],
    }
    const parent = "tool:patch"
    const child = "file:patch:0"
    const model = ViewState.update(
      { ...ViewState.initial("/work"), blocks: [call], expandedRowKeys: [parent] },
      { _tag: "DetailToggled", id: child },
    )

    expect(model).toMatchObject({ detailSelection: undefined, expandedRowKeys: [parent, child] })
  })

  test("navigates threads, selects permissions, and deduplicates replay", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second", unread: true })],
    })
    model = ViewState.update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
    model = ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed" })
    expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "b" })
    model = {
      ...model,
      blocks: [{ _tag: "Permission", id: "p", kind: "permission", title: "P", detail: "d", status: "pending" }],
    }
    model = ViewState.update(model, { _tag: "PermissionSelectionMoved", offset: -1 })
    model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "p" })
    expect(model.pendingAction).toEqual({ _tag: "DecidePermission", id: "p", kind: "permission", decision: "deny" })
    const event = {
      id: "stable",
      cursor: "42",
      block: { _tag: "ChildAgent", id: "review", name: "review", summary: "checking", status: "running", activity: [] },
    } as const
    model = ViewState.update(model, { _tag: "EventReplayed", event })
    const replayed = ViewState.update(model, { _tag: "EventReplayed", event })
    expect(replayed).toBe(model)
    expect(model).toMatchObject({ eventCursor: "42", seenEventIds: ["stable"] })
  })

  test("opens, filters, navigates, closes, and confirms the all-workspace thread switcher", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: [
        thread({ id: "a", title: "First", workspace: "/one" }),
        thread({ id: "b", title: "Second task", workspace: "/two", unread: true, archived: true }),
      ],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
    expect(model.threadSwitcher.open).toBe(true)
    model = ViewState.update(model, { _tag: "ThreadPreviewScrolled", offset: 5 })
    expect(model.threadSwitcher.previewScroll).toBe(5)
    for (const character of "second")
      model = ViewState.update(model, {
        _tag: "KeyPressed",
        key: key({ name: character, sequence: character }),
      })
    expect(model.threadSwitcher.previewScroll).toBe(0)
    expect(ViewState.filteredThreads(model).map((item) => item.id)).toEqual(["b"])
    expect(ViewState.selectedThreadMetadata(model)).toMatchObject({ id: "b", workspace: "/two", archived: true })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "b" })
    expect(model.threadSwitcher.open).toBe(false)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "w", alt: true }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.threadSwitcher.open).toBe(false)
  })

  test("clears stale previews for missing filters and removed or archived thread summaries", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "a", title: "Alpha" }), thread({ id: "b", title: "Beta" })],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
    model = ViewState.update(model, {
      _tag: "ThreadPreviewLoaded",
      threadId: "a",
      turns: [{ prompt: "stale preview", events: [] }],
    })
    for (const character of "missing")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    expect(model.threadPreview._tag).toBe("Idle")

    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
    model = ViewState.update(model, {
      _tag: "ThreadPreviewLoaded",
      threadId: "a",
      turns: [{ prompt: "removed preview", events: [] }],
    })
    model = ViewState.update(model, {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "b", title: "Beta" })],
    })
    expect(model.threadPreview._tag).toBe("Idle")
    expect(ViewState.selectedThreadMetadata(model)?.id).toBe("b")
    expect(model.threadSwitcher.previewScroll).toBe(0)
  })

  test("switches file completion to thread completion with @@ and inserts a typed thread mention", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "thread-2", title: "Release notes", workspace: "/two" })],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    expect(model.threadSwitcher).toMatchObject({ open: true, kind: "mention" })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", sequence: "r" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.input).toBe("@thread-2 ")
  })

  test("surfaces workspace file index failures and clears them on the next load", () => {
    let model = ViewState.update(ViewState.initial("/work"), { _tag: "FilesRequested" })
    expect(model.filePicker.items).toEqual({ _tag: "Loading" })
    model = ViewState.update(model, { _tag: "FilesFailed", message: "fff native library not found" })
    expect(model.filePicker.items).toEqual({ _tag: "Idle" })
    expect(model.filePicker.error).toBe("fff native library not found")
    model = ViewState.update(model, { _tag: "FilesReplaced", files: ["a.ts"] })
    expect(model.filePicker.items).toEqual({ _tag: "Ready", value: ["a.ts"] })
    expect(model.filePicker.error).toBeUndefined()
  })

  test("removes a complete Unicode query character and keeps file completion open", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "FilesReplaced",
      files: ["src/😀.ts"],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "😀", sequence: "😀" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    expect(model.input).toBe("@")
    expect(model.filePicker).toMatchObject({ open: true, query: "", selected: 0 })
  })

  test("selects from refreshed file and thread results without retaining stale indexes", () => {
    let files = ViewState.update(ViewState.initial("/work"), {
      _tag: "FilesReplaced",
      files: ["a.ts", "b.ts", "c.ts"],
    })
    files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "t", sequence: "t" }) })
    files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "down" }) })
    files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "down" }) })
    files = ViewState.update(files, { _tag: "FilesReplaced", files: ["only.ts"] })
    files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(files.input).toBe("@only.ts ")

    let threads = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "a", title: "A" }), thread({ id: "b", title: "B" }), thread({ id: "c", title: "C" })],
    })
    threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "down" }) })
    threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "down" }) })
    threads = ViewState.update(threads, {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "only", title: "Only" })],
    })
    threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(threads.input).toBe("@only ")
  })

  test("opens, focuses, navigates, and closes the fixed thread sidebar with ctrl+backslash", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second" })],
    })
    model = ViewState.update(model, { _tag: "ThreadActivated", threadId: "b", title: "Second" })
    const toggle = { _tag: "KeyPressed", key: key({ name: "\\", ctrl: true, sequence: "\u001c" }) } as const
    model = ViewState.update(model, toggle)
    expect(model.threadSidebar).toMatchObject({ open: true, focused: false, selected: 1 })
    model = ViewState.update(model, toggle)
    expect(model.threadSidebar.focused).toBe(true)
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "a" })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.threadSidebar).toMatchObject({ open: true, focused: false })
    model = ViewState.update(model, toggle)
    model = ViewState.update(model, toggle)
    expect(model.threadSidebar.open).toBe(false)
  })

  test("keeps the thread sidebar selection visible when stale threads disappear", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "ThreadsReplaced",
      threads: Array.from({ length: 40 }, (_, index) => thread({ id: String(index), title: `Thread ${index}` })),
    })
    model = {
      ...model,
      height: 8,
      threadSidebar: { open: true, focused: true, selected: 39, scrollTop: 32 },
    }
    model = ViewState.update(model, {
      _tag: "ThreadsReplaced",
      threads: [thread({ id: "fresh", title: "Fresh" })],
    })
    expect(model.threadSidebar).toMatchObject({ selected: 0, scrollTop: 0 })
  })

  test("bounds the thread sidebar on tiny terminals to preserve the main column", () => {
    const model = {
      ...ViewState.initial("/work"),
      width: 20,
      threadSidebar: { ...ViewState.initial("/work").threadSidebar, open: true },
    }
    expect(ViewState.boundedThreadSidebarWidth(model.width)).toBe(8)
    expect(ViewState.contentColumnWidth(model)).toBe(12)
  })

  test("covers reducer boundaries and every busy shortcut", () => {
    let model = ViewState.initial("/work")
    expect(ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed" })).toBe(model)
    model = ViewState.update(model, { _tag: "AllDetailsToggled" })
    model = ViewState.update(model, { _tag: "ThreadsReplaced", threads: [] })
    model = ViewState.update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 9 })
    model = ViewState.update(model, { _tag: "ScrollMoved", offset: -3 })
    model = ViewState.update(model, { _tag: "ReasoningToggled", index: 0 })
    model = ViewState.update(model, { _tag: "PaletteActionConsumed" })
    model = { ...model, busy: true, input: "go", cursor: 2 }
    expect(ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) }).pendingAction).toEqual({
      _tag: "Cancel",
    })
    expect(
      ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) }).pendingAction,
    ).toMatchObject({ _tag: "Steer" })
    expect(
      ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return", ctrl: true }) }).pendingAction,
    ).toMatchObject({ _tag: "InterruptAndSend" })
  })

  test("covers palette navigation, actions, mode wrapping, history boundaries, and explicit permission", () => {
    let model = ViewState.initial("/work", "low")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "m", ctrl: true }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    expect(model.modePicker.selected).toBe(3)
    expect(model.mode).toBe("low")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    for (const c of "mode") model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: c, sequence: c }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.modePicker.open).toBe(true)
    model = {
      ...model,
      blocks: [{ _tag: "Permission", id: "p", kind: "permission", title: "P", detail: "d", status: "pending" }],
    }
    model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "p", decision: "allow" })
    expect(model.pendingAction).toMatchObject({ decision: "allow" })
    model = {
      ...model,
      blocks: [
        { _tag: "Permission", id: "p", kind: "permission", title: "P", detail: "d", status: "pending" },
        { _tag: "Notification", title: "queued", detail: "x" },
      ],
    }
    model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "p", decision: "deny" })
    expect(model.blocks[0]).toMatchObject({ status: "denied" })
    const empty = ViewState.initial("/work")
    expect(ViewState.update(empty, { _tag: "KeyPressed", key: key({ name: "up" }) })).toBe(empty)
    expect(ViewState.inputRows({ ...empty, input: "\n".repeat(12) })).toBe(8)
  })

  test("replaces queue state without changing transcript blocks and covers remaining input navigation branches", () => {
    const base = {
      ...ViewState.initial("/work"),
      blocks: [{ _tag: "Notification", title: "N", detail: "d" }],
      history: ["alpha", "beta"],
    } as ViewState.Model
    const replaced = ViewState.replaceQueue(base, [
      { id: "new", prompt: "new" },
      { id: "next", prompt: "next" },
    ])
    expect(replaced.blocks).toEqual(base.blocks)
    expect(replaced.queue).toEqual([
      { id: "new", prompt: "new" },
      { id: "next", prompt: "next" },
    ])
    let model = ViewState.update(base, { _tag: "KeyPressed", key: key({ name: "down" }) })
    expect(model.input).toBe("")
    model = { ...model, input: "zzz", cursor: 3, historySearch: "alpha" }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
    expect(model.input).toBe("zzz")
    model = { ...model, input: "", cursor: 0, historySearch: "alpha" }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
    expect(model.input).toBe("alpha")
    expect(ViewState.isNarrow(ViewState.initial("/work"))).toBe(false)
    expect(ViewState.inputRows(ViewState.initial("/work"))).toBe(1)
  })

  test("blocks Enter submission while overlays or pending permissions are active", () => {
    const base = { ...ViewState.initial("/work"), input: "look at ", cursor: 8 }
    expect(ViewState.canSubmit(base)).toBe(true)
    expect(ViewState.canSubmit({ ...base, filePicker: { ...base.filePicker, open: true } })).toBe(false)
    expect(ViewState.canSubmit({ ...base, modePicker: { open: true, selected: 0 } })).toBe(false)
    expect(ViewState.canSubmit({ ...base, palette: { open: true, query: "", selected: 0 } })).toBe(false)
    expect(ViewState.canSubmit({ ...base, threadSwitcher: { ...base.threadSwitcher, open: true } })).toBe(false)
    expect(ViewState.canSubmit({ ...base, shortcutsOpen: true })).toBe(false)
    expect(ViewState.canSubmit({ ...base, input: "multi\\", cursor: 6 })).toBe(false)
    const withPermission = ViewState.update(base, {
      _tag: "BlockAdded",
      block: { _tag: "Permission", id: "p1", kind: "permission", title: "Run shell", detail: "ls", status: "pending" },
    })
    expect(ViewState.canSubmit(withPermission)).toBe(false)
  })

  test("selecting a file mention inserts it without clearing the composer", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "FilesReplaced",
      files: ["src/main.ts"],
    })
    model = { ...model, input: "explain ", cursor: 8 }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    expect(ViewState.canSubmit(model)).toBe(false)
    for (const character of "main")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    expect(model.input).toBe("explain @main")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.input).toBe("explain @src/main.ts ")
    expect(model.filePicker.open).toBe(false)
    expect(ViewState.canSubmit(model)).toBe(true)
    expect(model.entries).toHaveLength(0)
  })

  test("quotes a selected file mention containing spaces", () => {
    let model = ViewState.update(ViewState.initial("/work"), {
      _tag: "FilesReplaced",
      files: ["docs/read me.md"],
    })
    model = { ...model, input: "read ", cursor: 5 }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    for (const character of "read")
      model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.input).toBe('read @"docs/read me.md" ')
  })
})

describe("Keys", () => {
  test("normalizes OpenTUI modifiers and printable keys", () => {
    expect(Keys.fromOpenTui({ name: "x", meta: true }).alt).toBe(true)
    expect(Keys.fromOpenTui({ name: "x", super: true }).meta).toBe(true)
    expect(Keys.fromOpenTui({ name: "x" })).toMatchObject({ sequence: "", eventType: "press" })
    expect(Keys.isPrintable(key({ name: "x", sequence: "x" }))).toBe(true)
    expect(Keys.isPrintable(key({ name: "x", sequence: "x", ctrl: true }))).toBe(false)
    expect(Keys.isPrintable(key({ name: "x", sequence: "x", alt: true }))).toBe(false)
    expect(Keys.isPrintable(key({ name: "x", sequence: "x", meta: true }))).toBe(false)
    expect(Keys.isPrintable(key({ name: "x", sequence: "" }))).toBe(false)
    expect(Keys.isPrintable(key({ name: "x", sequence: "\u001f" }))).toBe(false)
    expect(Keys.isPrintable(key({ name: "x", sequence: "\u007f" }))).toBe(false)
  })
})

describe("loadable panel state machine", () => {
  it("transitions changed files idle to loading to ready and keeps ready on refresh", () => {
    const base = ViewState.initial("/work")
    expect(base.changedFiles).toEqual({ _tag: "Idle" })
    const loading = ViewState.update(base, { _tag: "ChangedFilesRequested" })
    expect(loading.changedFiles).toEqual({ _tag: "Loading" })
    const ready = ViewState.update(loading, {
      _tag: "ChangedFilesReplaced",
      files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }],
    })
    expect(ready.changedFiles._tag).toBe("Ready")
    const requestedAgain = ViewState.update(ready, { _tag: "ChangedFilesRequested" })
    expect(requestedAgain.changedFiles._tag).toBe("Ready")
    const refreshed = ViewState.update(requestedAgain, {
      _tag: "ChangedFilesReplaced",
      files: [{ path: "b.ts", status: "A", added: 2, removed: 0 }],
    })
    expect(ViewState.readyOr(refreshed.changedFiles, []).map((file) => file.path)).toEqual(["b.ts"])
  })

  it("transitions workspace files and keeps a stale thread preview while the next one loads", () => {
    const base = ViewState.initial("/work")
    expect(base.filePicker.items).toEqual({ _tag: "Idle" })
    const loading = ViewState.update(base, { _tag: "FilesRequested" })
    expect(loading.filePicker.items).toEqual({ _tag: "Loading" })
    const ready = ViewState.update(loading, { _tag: "FilesReplaced", files: ["src/main.ts"] })
    expect(ViewState.readyOr(ready.filePicker.items, [])).toEqual(["src/main.ts"])
    expect(ViewState.update(ready, { _tag: "FilesRequested" }).filePicker.items._tag).toBe("Ready")
    const firstPreviewLoading = ViewState.update(base, { _tag: "ThreadPreviewRequested" })
    expect(firstPreviewLoading.threadPreview).toEqual({ _tag: "Loading" })
    const previous = ViewState.update(firstPreviewLoading, {
      _tag: "ThreadPreviewLoaded",
      threadId: "thread-0",
      turns: [{ prompt: "previous", events: [] }],
    })
    const previewLoading = ViewState.update(previous, { _tag: "ThreadPreviewRequested" })
    expect(previewLoading.threadPreview).toEqual({
      _tag: "Loading",
      previous: { threadId: "thread-0", turns: [{ prompt: "previous", events: [] }] },
    })
    const previewReady = ViewState.update(previewLoading, {
      _tag: "ThreadPreviewLoaded",
      threadId: "thread-1",
      turns: [{ prompt: "hi", events: [] }],
    })
    expect(previewReady.threadPreview._tag).toBe("Ready")
    const opening = ViewState.update(base, { _tag: "ThreadOpenRequested" })
    expect(opening.threadLoading).toBe(true)
    expect(ViewState.update(opening, { _tag: "ThreadOpenCompleted" }).threadLoading).toBe(false)
  })

  it("clamps the sidebar width on change and terminal resize", () => {
    const base = { ...ViewState.initial("/work"), width: 120, height: 40 }
    expect(ViewState.update(base, { _tag: "SidebarWidthChanged", width: 200 }).sidebarWidth).toBe(80)
    expect(ViewState.update(base, { _tag: "SidebarWidthChanged", width: 10 }).sidebarWidth).toBe(24)
    const widened = ViewState.update(base, { _tag: "SidebarWidthChanged", width: 60 })
    expect(widened.sidebarWidth).toBe(60)
    const shrunk = ViewState.update(widened, { _tag: "Resized", width: 70, height: 40 })
    expect(shrunk.sidebarWidth).toBe(30)
  })
})
