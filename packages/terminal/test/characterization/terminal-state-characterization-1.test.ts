import { expect, test } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { commands, filter } from "../../src/presentation/terminal/command-palette"
import {
  formatActivity,
  formatActivityCounter,
  runningToolsActivity,
} from "../../src/state/model/terminal-activity-state"
import { activeTimeAt } from "../../src/state/model/terminal-activity-time"
import { classifyPrompt, promptParts } from "../../src/state/model/terminal-composer-state"
import { composerHeight, inputRows, wrappedRowCount } from "../../src/state/model/terminal-layout-composer"
import { isNarrow } from "../../src/state/model/terminal-layout-state"
import { ready } from "../../src/state/model/terminal-loadable-state"
import { nextUsageDisplay } from "../../src/state/model/terminal-mode-selection"
import { replaceTurnPrompt } from "../../src/state/model/terminal-queue-prompt"
import { applyQueueDelta, replaceQueue, resetQueue } from "../../src/state/model/terminal-queue-state"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { filteredFiles } from "../../src/state/model/terminal-thread-navigation"
import { update } from "../../src/state/reducer/terminal-state-reducer"

import { formatTokens } from "../../src/presentation/terminal/terminal-format"
import { key, _thread, readCall, _editFile, _busyQueueModel } from "./terminal-state-characterization-1-support"
test("cycles cost, tokens, and active time", () => {
  expect(nextUsageDisplay("cost")).toBe("tokens")
  expect(nextUsageDisplay("tokens")).toBe("time")
  expect(nextUsageDisplay("time")).toBe("cost")
})
test("adds only an open active interval to accumulated time", () => {
  expect(activeTimeAt({ _tag: "Available", accumulatedMillis: 5_000, activeSince: 10_000 }, 53_000)).toEqual(
    Duration.seconds(48),
  )
  expect(activeTimeAt({ _tag: "Available", accumulatedMillis: 5_000 }, 53_000)).toEqual(Duration.seconds(5))
})
test("tracks only the five turn activity states", () => {
  let model = { ...initial("/work", "medium"), input: "run it", cursor: 6 }
  model = update(model, { _tag: "Submitted" })
  expect(model.activity).toEqual({ _tag: "Sending" })
  expect(formatActivity(model.activity)).toBe("Sending")

  model = update(model, { _tag: "TurnStarted", turnId: "turn", prompt: "run it" })
  expect(formatActivity(model.activity)).toBe("Waiting")

  model = update(model, { _tag: "ReasoningStreamed", text: "12345678🙂" })
  expect(formatActivity(model.activity)).toBe("Thinking 3 tok")
  model = update(model, { _tag: "ReasoningStreamed", text: "abcd" })
  expect(formatActivity(model.activity)).toBe("Thinking 4 tok")
  model = update(model, { _tag: "AssistantStreamed", text: "abcdefgh", turnId: "turn" })
  expect(formatActivity(model.activity)).toBe("Streaming 2 tok")
  model = update(model, { _tag: "AssistantCompleted", text: "abcdefgh", turnId: "turn" })
  expect(formatActivity(model.activity)).toBe("Waiting")
  expect(formatActivity({ _tag: "Compacting" })).toBe("Auto-Compacting")

  model = update(model, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) })
  expect(formatActivity(model.activity)).toBe("Waiting")
})
test("formats Amp activity counters with the singular tok unit", () => {
  expect(formatActivity({ _tag: "Thinking", bytes: 0 })).toBe("Thinking 0 tok")
  expect(formatActivityCounter(1)).toBe("1 tok")
  expect(formatActivityCounter(999)).toBe("999 tok")
  expect(formatActivityCounter(1_234)).toBe("1.2K tok")
  expect(formatActivityCounter(2_000)).toBe("2K tok")
  expect(formatActivityCounter(12_345)).toBe("12.3K tok")
  expect(formatActivityCounter(1_234_567)).toBe("1.2M tok")
  expect(formatActivityCounter(1_234)).toBe(formatTokens(1_234))
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
  const activity = runningToolsActivity({
    ...initial("/work"),
    blocks,
    items: [
      { _tag: "Block", index: 0, id: "tool:root-agent" },
      { _tag: "Block", index: 1, id: "tool:nested-agent", parentId: "root-agent" },
      { _tag: "Block", index: 2, id: "tool:root-read" },
      { _tag: "Block", index: 3, id: "tool:nested-read", parentId: "nested-agent" },
    ],
  })

  expect(activity).toEqual({ _tag: "RunningTools", subagents: 1, tools: 2 })
  expect(formatActivity(activity)).toBe("Running 1 subagent, 2 tools")
  expect(formatActivity({ _tag: "RunningTools", subagents: 5, tools: 3 })).toBe("Running 5 subagents, 3 tools")
})
test("exposes only thread switch, mode change, fast mode, and quit in the command palette", () => {
  expect(commands).toEqual([
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
  expect(filter("review")).toEqual([])
  expect(filter("reasoning")).toEqual([])
  expect(filter("changed files")).toEqual([])
})
it.effect("completes file mentions and exposes mode and shortcuts state", () =>
  Effect.sync(() => {
    let model = update(initial("/work", "medium"), {
      _tag: "FilesReplaced",
      files: ["src/main.ts", "docs/SPEC.md"],
    })
    model = update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
    model = { ...model, filePicker: { ...model.filePicker, query: "main" } }
    expect(filteredFiles(model)).toEqual(["src/main.ts"])
    model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.input).toBe("@src/main.ts ")
    model = update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) })
    expect(model.modePicker).toEqual({ open: true, selected: 1 })
    model = update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) })
    model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.mode).toBe("high")
    model = { ...model, input: "", cursor: 0 }
    model = update(model, { _tag: "KeyPressed", key: key({ name: "?", sequence: "?" }) })
    expect(model.shortcutsOpen).toBe(true)
    expect(model.input).toBe("?")
  }),
)
test("leaves Opt+D unbound", () => {
  const model = initial("/work", "medium")
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "d", alt: true }) })).toEqual(model)
})
test("preserves ordered prompt parts for bracketed paths and file URLs", () => {
  expect(promptParts("before [shots/a.png] after file:///tmp/b%20c.webp")).toEqual([
    { type: "text", text: "before " },
    { type: "image", path: "shots/a.png" },
    { type: "text", text: " after " },
    { type: "image", path: "/tmp/b c.webp" },
  ])
  expect(promptParts("inspect /tmp/dropped\\ image.png now")).toEqual([
    { type: "text", text: "inspect " },
    { type: "image", path: "/tmp/dropped image.png" },
    { type: "text", text: " now" },
  ])
})
test("edits, moves, and submits input", () => {
  let model = initial("/work")
  expect(update(model, { _tag: "Submitted" })).toBe(model)
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })).toBe(model)
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })).toBe(model)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "h", sequence: "h" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "i", sequence: "i" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "left" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "right" }) })
  expect(model.input).toBe("xi")
  model = update(model, { _tag: "Submitted" })
  expect(model.entries).toEqual([])
  expect(model.busy).toBe(true)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "q", sequence: "q" }) })
  model = update(model, { _tag: "Submitted" })
  expect(model.entries).toEqual([])
  model = update(model, { _tag: "TurnStarted", turnId: "q", prompt: "q" })
  expect(model.entries.at(-1)).toEqual({ role: "user", text: "q", turnId: "q" })
  expect(model.busy).toBe(true)
})
test("classifies shell prompts and keeps incognito commands out of prompt semantics", () => {
  expect(classifyPrompt("$ echo ok")).toEqual({ _tag: "Shell", command: "echo ok", incognito: false })
  expect(classifyPrompt("$$ secret")).toEqual({ _tag: "Shell", command: "secret", incognito: true })
  expect(classifyPrompt("explain $PATH")).toEqual({ _tag: "Prompt", prompt: "explain $PATH" })
})
test("replaces the visible prompt for an existing Turn without changing execution state", () => {
  const started = update(initial("/work"), {
    _tag: "TurnStarted",
    turnId: "queued",
    prompt: "before",
  })
  const model = replaceTurnPrompt({ ...started, busy: false, activeTurnId: undefined }, "queued", "after")
  expect(model.entries).toEqual([{ role: "user", text: "after", turnId: "queued" }])
  expect(model.busy).toBe(false)
  expect(model.activeTurnId).toBeUndefined()
  const promoted = update(model, { _tag: "TurnStarted", turnId: "queued", prompt: "after" })
  expect(promoted.entries).toEqual([{ role: "user", text: "after", turnId: "queued" }])
  expect(promoted.busy).toBe(true)
})
test("applies revisioned queue deltas and requests a resync on gaps or invalid changes", () => {
  let model = resetQueue({ ...initial("/work"), currentThreadId: "thread" }, "thread", 3, [
    { id: "one", prompt: "one" },
  ])
  let applied = applyQueueDelta(model, "thread", 4, {
    _tag: "Added",
    item: { id: "two", prompt: "two" },
  })
  expect(applied.resync).toBe(false)
  expect(applied.model.queue.map((item) => item.id)).toEqual(["one", "two"])
  model = { ...applied.model, queueSelection: "two" }

  applied = applyQueueDelta(model, "thread", 4, {
    _tag: "Added",
    item: { id: "two", prompt: "duplicate" },
  })
  expect(applied).toEqual({ model, resync: false })

  expect(applyQueueDelta(model, "thread", 6, { _tag: "Removed", turnId: "one" }).resync).toBe(true)
  expect(applyQueueDelta(model, "other", 5, { _tag: "Removed", turnId: "one" }).resync).toBe(false)

  applied = applyQueueDelta(model, "thread", 5, {
    _tag: "Updated",
    item: { id: "two", prompt: "edited" },
  })
  expect(applied.model.queue[1]?.prompt).toBe("edited")
  applied = applyQueueDelta(applied.model, "thread", 6, { _tag: "Removed", turnId: "two" })
  expect(applied.resync).toBe(false)
  expect(applied.model.queue).toEqual([{ id: "one", prompt: "one" }])
  expect(applied.model.queueSelection).toBe("one")
})
test("supports multiline, palette, release, and resize messages", () => {
  let model = initial("/work", "high")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return", shift: true }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "linefeed" }) })
  expect(model.input).toBe("\n\n")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  expect(model.paletteOpen).toBe(true)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.paletteOpen).toBe(false)
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x", eventType: "release" }) })).toEqual(
    model,
  )
  model = update(model, { _tag: "Resized", width: 50, height: 12 })
  expect([model.width, model.height]).toEqual([50, 12])
  expect(isNarrow(model)).toBe(true)
})
test("reduces a resize storm to the final size", () => {
  let model = initial("/work", "high")
  for (const [width, height] of [
    [100, 40],
    [90, 30],
    [70, 20],
    [132, 43],
  ] as const)
    model = update(model, { _tag: "Resized", width, height })
  expect([model.width, model.height]).toEqual([132, 43])
})
test("grows multiline input and supports newline shortcuts and history search", () => {
  let model = initial("/work")
  for (const character of "first")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "Submitted" })
  model = { ...model, input: "second", cursor: 6 }
  model = update(model, { _tag: "Submitted" })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.input).toBe("second")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.input).toBe("first")
  model = { ...model, input: "cond", cursor: 4 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
  expect(model.input).toBe("second")
  model = { ...model, input: "a\\", cursor: 2 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "j", ctrl: true }) })
  expect(model.input).toBe("a\n\n")
  expect(inputRows(model)).toBe(3)
})
test("auto-grows and manually resizes the composer within terminal bounds", () => {
  let model = { ...initial("/work"), input: "one\ntwo\nthree\nfour", cursor: 18 }
  expect(composerHeight(model)).toBe(6)
  model = update(model, { _tag: "ComposerHeightChanged", height: 12 })
  expect(composerHeight(model)).toBe(12)
  model = update(model, { _tag: "ComposerHeightChanged", height: 2 })
  expect(composerHeight(model)).toBe(6)
  model = update(model, { _tag: "ComposerHeightChanged", height: 20 })
  model = update(model, { _tag: "Resized", width: 80, height: 10 })
  expect(model.composerHeight).toBe(6)
  expect(composerHeight(model)).toBe(6)
})
test("counts composer rows by terminal cell width for wide, combining, and sidebar-narrowed input", () => {
  const cjk = { ...initial("/work", "high"), width: 40, input: "文".repeat(40) }
  expect(inputRows(cjk)).toBe(3)

  const combining = { ...initial("/work", "high"), width: 12, input: "e\u0301".repeat(8) }
  expect(inputRows(combining)).toBe(1)

  expect(wrappedRowCount("👩‍💻", 3)).toBe(1)

  const sidebar = {
    ...initial("/work", "high"),
    width: 100,
    changedFilesOpen: true,
    changedFiles: ready([{ path: "a.ts", status: "M" }]),
    sidebarWidth: 40,
    input: "x".repeat(70),
  }
  expect(inputRows(sidebar)).toBe(2)
  expect(inputRows({ ...sidebar, changedFilesOpen: false })).toBe(1)
})
test("keeps queue state outside the transcript and tracks reasoning and scroll follow", () => {
  let model = replaceQueue(initial("/work"), [{ id: "queued", prompt: "old" }])
  model = update(model, { _tag: "ReasoningStreamed", text: "details" })
  model = update(model, { _tag: "ReasoningToggled", index: 0 })
  expect(model.blocks).toEqual([{ _tag: "Reasoning", text: "details" }])
  expect(model.expandedRowKeys).toEqual(["block:Reasoning:0"])
  expect(model.queue).toEqual([{ id: "queued", prompt: "old" }])
  model = update(model, { _tag: "ScrollMoved", offset: 4 })
  expect(model.scrollFollow).toBe(false)
  model = update(model, { _tag: "ScrollFollowed" })
  expect(model).toMatchObject({ scrollFollow: true, scrollOffset: 0 })
})
test("leaves transcript navigation keys to the viewport owner", () => {
  let model: Model = {
    ...initial("/work"),
    height: 24,
    entries: Array.from({ length: 80 }, (_, index) => ({ role: "assistant" as const, text: `line ${index}` })),
    scrollOffset: 120,
  }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "pageup" }) })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  model = update(model, { _tag: "AssistantStreamed", text: "more" })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "pagedown" }) })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "end" }) })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
})
test("streams, completes, and reports failures", () => {
  let model = initial("/work")
  model = update(model, { _tag: "AssistantStreamed", text: "hel" })
  model = update(model, { _tag: "AssistantStreamed", text: "lo" })
  expect(model.entries).toEqual([{ role: "assistant", text: "hello" }])
  model = update(model, { _tag: "AssistantCompleted", text: "final" })
  expect(model.entries).toEqual([{ role: "assistant", text: "final" }])
  model = update(model, { _tag: "AssistantStreamed", text: "next" })
  model = update(model, { _tag: "AssistantCompleted", text: "next final" })
  expect(model.entries).toEqual([
    { role: "assistant", text: "final" },
    { role: "assistant", text: "next final" },
  ])
  model = update(model, { _tag: "AssistantCompleted", text: "completion only" })
  expect(model.entries.at(-1)).toEqual({ role: "assistant", text: "completion only" })
  expect(model.entries).toHaveLength(3)
  model = update(model, { _tag: "ExecutionFailed", message: "failed" })
  expect(model.blocks.at(-1)).toEqual({
    _tag: "Error",
    title: "Message failed",
    detail: "failed",
    recovery: "Press Enter to try again.",
  })
  expect(model.items.at(-1)).toEqual({ _tag: "Block", index: 0 })
  expect(model.busy).toBe(false)
  model = { ...model, input: "try again", cursor: 9 }
  model = update(model, { _tag: "Submitted" })
  expect(model.entries.at(-1)).toEqual({ role: "assistant", text: "completion only" })
  model = update(model, { _tag: "TurnStarted", turnId: "retry", prompt: "try again" })
  expect(model.entries.at(-1)).toEqual({ role: "user", text: "try again", turnId: "retry" })
  expect(model.items.at(-1)).toEqual({ _tag: "Entry", index: 3, id: "turn:retry:user", turnId: "retry" })
  expect(model).toMatchObject({ input: "", busy: true })
  model = update(initial("/work"), { _tag: "AssistantCompleted", text: "standalone" })
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
  const running: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn",
    blocks: [parent, child],
    items: [
      { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child", turnId: "turn:child", parentId: "parent" },
    ],
  }

  const cancelled = update(running, { _tag: "ExecutionCancelled", turnId: "turn" })
  const repeated = update(cancelled, { _tag: "ExecutionCancelled", turnId: "turn" })

  expect(cancelled.blocks).toEqual([
    expect.objectContaining({ id: "parent", status: "cancelled" }),
    expect.objectContaining({ id: "child", status: "cancelled" }),
  ])
  expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
  expect(repeated).toBe(cancelled)
})
test("restores a submitted draft when cancellation arrives before an agent response", () => {
  let running = update({ ...initial("/work"), input: "cancel this prompt", cursor: 6 }, { _tag: "Submitted" })
  const attachment = { type: "text" as const, token: "token", value: "attachment", label: "Pasted text #1" }
  running = update(
    { ...running, pastedText: [attachment] },
    { _tag: "TurnStarted", turnId: "turn", prompt: "cancel this prompt" },
  )
  running = {
    ...running,
    submittedDrafts: [{ input: "cancel this prompt", cursor: 6, attachments: [attachment], turnId: "turn" }],
  }

  const cancelled = update(running, {
    _tag: "ExecutionCancelled",
    turnId: "turn",
    agentResponseArrived: false,
  })
  const repeated = update(cancelled, {
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
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    input: "queued follow-up",
  }
  const submitted = update(busy, { _tag: "Submitted", submissionId: "sub-q" })
  expect(submitted.input).toBe("")
  expect(submitted.busy).toBe(true)
  expect(submitted.pendingSteering).toEqual([])
  expect(submitted.pendingAction).toBeUndefined()
  expect(submitted.submittedDrafts).toEqual([
    { input: "queued follow-up", attachments: [], cursor: 0, submissionId: "sub-q" },
  ])
})
test("submitting while busy echoes a provisional queue row immediately", () => {
  const busy: Model = resetQueue(
    {
      ...initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      currentThreadId: "thread",
      input: "queued prompt",
    },
    "thread",
    3,
    [],
  )
  const submitted = update(busy, { _tag: "Submitted", submissionId: "sub-1" })
  expect(submitted.queue).toEqual([{ id: "sub-1", prompt: "queued prompt", provisional: true }])
  expect(submitted.queueRevision).toBe(3)
  expect(submitted.input).toBe("")
})
