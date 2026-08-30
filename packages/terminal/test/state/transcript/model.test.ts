import "./interaction.fixture"
import { expect, test } from "vitest"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"

import { key, readCall } from "./model.fixture"
test("a stale terminal event for another turn does not clear the active turn", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-b",
    submittedDrafts: [{ input: "second", attachments: [], cursor: 0, turnId: "turn-b" }],
  }
  const afterStale = update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(afterStale.busy).toBe(true)
  expect(afterStale.activeTurnId).toBe("turn-b")
  expect(afterStale.submittedDrafts).toHaveLength(1)
})
test("settles a completed projected turn after active selection clears", () => {
  const projected: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: undefined,
    activity: { _tag: "Waiting" },
    submittedDrafts: [{ input: "prompt", attachments: [], cursor: 0, turnId: "turn-a" }],
  }
  const completed = update(projected, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(completed.busy).toBe(false)
  expect(completed.activity).toBeUndefined()
  expect(completed.submittedDrafts).toEqual([])
})
test("settles cancellation without adding a textual notice", () => {
  const running: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn",
    submittedDrafts: [{ input: "submitted", cursor: 9, attachments: [], turnId: "turn" }],
  }

  const cancelled = update(running, {
    _tag: "ExecutionCancelled",
    turnId: "turn",
    agentResponseArrived: true,
  })

  expect(cancelled.entries).toEqual([])
  expect(cancelled.items).toEqual([])
  expect(cancelled.input).toBe("")
})
test("does not append a generic failure after the durable error arrived", () => {
  const failure = {
    _tag: "Error" as const,
    title: "Model authentication failed",
    detail: "Credential rejected",
  }
  const model: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn",
    blocks: [failure],
    items: [{ _tag: "Block", index: 0, turnId: "turn" }],
  }

  const settled = update(model, {
    _tag: "ExecutionFailed",
    turnId: "turn",
    failure: {
      tag: "TestFailure",
      message: "Execution failed",
      category: "operation",
      retryable: false,
      retry: "none",
      actor: "environment",
    },
  })

  expect(settled.blocks).toEqual([failure])
  expect(settled.items).toHaveLength(1)
  expect(settled.busy).toBe(false)
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
  const running: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn",
    blocks: [parent, child],
  }

  const cancelled = update(running, { _tag: "ExecutionCancelled", turnId: "turn" })

  expect(cancelled.blocks).toEqual([
    expect.objectContaining({ id: "parent", status: "cancelled" }),
    expect.objectContaining({ id: "child", status: "cancelled" }),
  ])
  expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
})
test("models structured transcript blocks without backend types", () => {
  let model = initial("/work")
  model = update(model, { _tag: "ReasoningStreamed", text: "checking " })
  model = update(model, { _tag: "ReasoningStreamed", text: "files" })
  model = update(model, {
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
  model = update(model, {
    _tag: "BlockAdded",
    block: { _tag: "ToolResult", id: "1", output: "ok", failed: false },
  })
  model = update(model, {
    _tag: "BlockAdded",
    block: { _tag: "Diff", path: "a.ts", patch: "+hello" },
  })
  expect(model.blocks).toHaveLength(4)
  expect(model.blocks[0]).toMatchObject({ _tag: "Reasoning", text: "checking files" })
})
test("executes every focused palette action", () => {
  let model = initial("/work")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "change mode")
    model = update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.modePicker.open).toBe(true)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.mode).toBe("high")

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "thread switch")
    model = update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.threadSwitcher.open).toBe(true)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "usage")
    model = update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.contextDetailsOpen).toBe(true)
  expect(model.pendingAction).toBeUndefined()
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "fast")
    model = update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.fastMode).toBe(true)

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "quit")
    model = update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "Quit" })
})
test("keeps overlays exclusive and types @ and ? into a non-empty composer", () => {
  let model = { ...initial("/work"), input: "draft", cursor: 5 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  expect(model).toMatchObject({
    paletteOpen: false,
    palette: { open: false },
    filePicker: { open: true },
  })
  expect(model.input).toBe("draft@")
  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({ shortcutsOpen: false, filePicker: { open: true, query: "?" } })
  expect(model.input).toBe("draft@?")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.filePicker.open).toBe(false)
  expect(model.input).toBe("draft@?")
  model = { ...model, input: "", cursor: 0 }
  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model.shortcutsOpen).toBe(true)
  expect(model.input).toBe("?")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.shortcutsOpen).toBe(false)
})
test("opens shortcuts only for the first question mark in an empty composer", () => {
  let sentence = { ...initial("/work"), input: "how was your day", cursor: 16 }
  sentence = update(sentence, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(sentence).toMatchObject({
    input: "how was your day?",
    cursor: 17,
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  })

  let model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({ input: "?", cursor: 1, shortcutsOpen: true, shortcutsTrigger: 0 })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "a", sequence: "a" }) })
  expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: true, shortcutsTrigger: 0 })

  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({
    input: "?a",
    cursor: 2,
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  })

  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({
    input: "?a?",
    cursor: 3,
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  })

  model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model).toMatchObject({
    input: "",
    cursor: 0,
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  })
})
test("does not open shortcuts when question mark is typed in a dialog", () => {
  let model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({
    shortcutsOpen: false,
    palette: { open: true, query: "?" },
    input: "",
  })
})
test("keeps an empty palette open with a valid selection and no action", () => {
  let model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  for (const character of "no such command")
    model = update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.palette.selected).toBe(0)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model).toMatchObject({ paletteOpen: true, palette: { open: true, selected: 0 } })
  expect(model.pendingAction).toBeUndefined()
})
test("switches mutually exclusively between the workspace file tree and changed files", () => {
  let model = initial("/work")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "s", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: true })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: false })
})
test("toggles every transcript detail as one reducer action", () => {
  let model: Model = {
    ...initial("/work"),
    blocks: [
      { _tag: "Reasoning", text: "why" },
      readCall("read", "src/a.ts", "complete"),
      { _tag: "Diff", path: "src/a.ts", patch: "+a" },
    ],
  }
  model = update(model, { _tag: "AllDetailsToggled" })
  expect(model.expandedRowKeys).toEqual(["block:Reasoning:0", "tool:read", "block:Diff:2"])
  model = update(model, { _tag: "AllDetailsToggled" })
  expect(model.expandedRowKeys).toEqual([])
})
test("keeps error details visible without expansion and types uppercase D into a nonempty composer", () => {
  const base: Model = {
    ...initial("/work"),
    blocks: [{ _tag: "Error", title: "Execution failed", detail: "Model unavailable" }],
  }

  const unchanged = update(base, {
    _tag: "KeyPressed",
    key: key({ name: "d", sequence: "D", shift: true }),
  })
  expect(unchanged.expandedRowKeys).toEqual([])

  const typed = update(
    { ...base, input: "draft", cursor: 5 },
    { _tag: "KeyPressed", key: key({ name: "d", sequence: "D", shift: true }) },
  )
  expect(typed).toMatchObject({ input: "draftD", expandedRowKeys: [] })
})
test("keeps an unchanged changed-files snapshot stable", () => {
  const files = [{ path: "src/a.ts", status: "M", added: 1, removed: 2 }]
  const model = update(initial("/work"), { _tag: "ChangedFilesReplaced", files })

  expect(update(model, { _tag: "ChangedFilesReplaced", files: [...files] })).toBe(model)
})
