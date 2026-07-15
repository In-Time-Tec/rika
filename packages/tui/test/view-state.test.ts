import { describe, expect, test } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
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

describe("ViewState", () => {
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
        keybinding: "Ctrl+C Ctrl+C",
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
    }),
  )

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
    model = ViewState.update(model, { _tag: "SubmissionQueued", prompt: "q" })
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

  test("keeps queue state outside the transcript and tracks reasoning and scroll follow", () => {
    let model = ViewState.replaceQueue(ViewState.initial("/work"), [{ id: "queued", prompt: "old" }])
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "details" })
    model = ViewState.update(model, { _tag: "ReasoningToggled", index: 0 })
    expect(model.blocks).toEqual([{ _tag: "Reasoning", text: "details", expanded: true }])
    expect(model.queue).toEqual([{ id: "queued", prompt: "old" }])
    model = ViewState.update(model, { _tag: "ScrollMoved", offset: 4 })
    expect(model.scrollFollow).toBe(false)
    model = ViewState.update(model, { _tag: "ScrollFollowed" })
    expect(model).toMatchObject({ scrollFollow: true, scrollOffset: 0 })
  })

  test("pages through a long transcript, stays detached while streaming, and follows again at End", () => {
    let model: ViewState.Model = {
      ...ViewState.initial("/work"),
      height: 24,
      entries: Array.from({ length: 80 }, (_, index) => ({ role: "assistant" as const, text: `line ${index}` })),
      scrollOffset: 120,
    }
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "pageup" }) })
    expect(model).toMatchObject({ scrollOffset: 102, scrollFollow: false })
    model = ViewState.update(model, { _tag: "AssistantStreamed", text: "more" })
    expect(model).toMatchObject({ scrollOffset: 102, scrollFollow: false })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "pagedown" }) })
    expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: false })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "end" }) })
    expect(model).toMatchObject({ scrollOffset: 0, scrollFollow: true })
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
      title: "Execution failed",
      detail: "failed",
      recovery: "Edit your prompt and press Enter to try again.",
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

  test("models structured transcript blocks without backend types", () => {
    let model = ViewState.initial("/work")
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "checking " })
    model = ViewState.update(model, { _tag: "ReasoningStreamed", text: "files" })
    model = ViewState.update(model, {
      _tag: "BlockAdded",
      block: { _tag: "ToolCall", id: "1", name: "Read", input: "a.ts", status: "running" },
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
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
    expect(model.shortcutsOpen).toBe(false)
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

  test("switches mutually exclusively between the file tree and changed files", () => {
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

  test("selects queued turns and executes dequeue and steering keys", () => {
    let model = ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
      { id: "one", prompt: "one" },
      { id: "two", prompt: "two" },
    ])
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    expect(model.queueSelection).toBe("one")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
    expect(model.queueSelection).toBe("two")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
    expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "two", prompt: "two" })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
    expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "two" })
  })

  test("dequeues the displayed default queue item on immediate Backspace", () => {
    const model = ViewState.update(
      ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
        { id: "first", prompt: "first" },
        { id: "second", prompt: "second" },
      ]),
      { _tag: "KeyPressed", key: key({ name: "backspace" }) },
    )
    expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "first" })
  })

  test("navigates transcript detail units with Tab and toggles the selected unit", () => {
    let model = {
      ...ViewState.initial("/work"),
      blocks: [
        { _tag: "Reasoning", text: "why", expanded: false },
        { _tag: "ToolCall", id: "1", name: "read_file", input: "a", status: "complete", expanded: false },
        { _tag: "Diff", path: "a", patch: "+a", expanded: false },
      ],
    } as ViewState.Model
    model = ViewState.update(
      { ...model, detailSelection: "block:Diff:2" },
      { _tag: "DetailToggled", id: "block:Diff:2" },
    )
    expect(model).toMatchObject({
      detailSelection: "block:Diff:2",
      blocks: [{ expanded: false }, {}, { expanded: true }],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab", shift: true }) })
    expect(model.detailSelection).toBe("tool:1")
    model = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
    expect(model).toMatchObject({
      detailSelection: "tool:1",
      blocks: [{ expanded: false }, { expanded: true }, { expanded: true }],
    })
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
    expect(model.detailSelection).toBe("block:Diff:2")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
    expect(model.detailSelection).toBe("block:Reasoning:0")
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
      block: { _tag: "ChildAgent", name: "review", summary: "checking", status: "running" },
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

  test("covers reducer boundaries and every busy shortcut", () => {
    let model = ViewState.initial("/work")
    expect(ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed" })).toBe(model)
    model = ViewState.update(model, { _tag: "WorkspaceFilesToggled" })
    model = ViewState.update(model, { _tag: "ThreadsReplaced", threads: [] })
    model = ViewState.update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 9 })
    model = ViewState.update(model, { _tag: "ScrollMoved", offset: -3 })
    model = ViewState.update(model, { _tag: "BlockAdded", block: { _tag: "Queued", id: "x", prompt: "x" } })
    model = ViewState.update(model, { _tag: "QueuedEdited", index: 3, prompt: "no" })
    model = ViewState.update(model, { _tag: "QueuedDequeued", index: 3 })
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
        { _tag: "Queued", id: "queued", prompt: "x" },
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

  it("transitions workspace files and thread previews through loading states", () => {
    const base = ViewState.initial("/work")
    expect(base.filePicker.items).toEqual({ _tag: "Idle" })
    const loading = ViewState.update(base, { _tag: "FilesRequested" })
    expect(loading.filePicker.items).toEqual({ _tag: "Loading" })
    const ready = ViewState.update(loading, { _tag: "FilesReplaced", files: ["src/main.ts"] })
    expect(ViewState.readyOr(ready.filePicker.items, [])).toEqual(["src/main.ts"])
    expect(ViewState.update(ready, { _tag: "FilesRequested" }).filePicker.items._tag).toBe("Ready")
    const previewLoading = ViewState.update(base, { _tag: "ThreadPreviewRequested" })
    expect(previewLoading.threadPreview).toEqual({ _tag: "Loading" })
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
