import { expect, test } from "vitest"

import { it } from "@effect/vitest"

import * as TranscriptProjection from "@rika/transcript/transcript-projection"

import { fromOpenTui, isPrintable, type Key } from "../../src/presentation/terminal/terminal-keymap"
import { inputRows } from "../../src/state/model/terminal-layout-composer"
import { isNarrow } from "../../src/state/model/terminal-layout-state"
import { readyOr } from "../../src/state/model/terminal-loadable-state"
import { replaceQueue } from "../../src/state/model/terminal-queue-state"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { type ThreadItem } from "../../src/state/model/terminal-thread-state"
import { type TranscriptBlock } from "../../src/state/model/terminal-transcript-state"
import { canSubmit, update } from "../../src/state/reducer/terminal-state-reducer"

const key = (input: Partial<Key> & Pick<Key, "name">): Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

const _thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

const _readCall = (
  id: string,
  detail: string,
  status: "running" | "complete" = "running",
): Extract<TranscriptBlock, { _tag: "ToolCall" }> => ({
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

const _editFile = (id: string, path: string) => ({
  key: id,
  path,
  kind: "update" as const,
  patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  preview: false,
  status: "complete" as const,
})

const _busyQueueModel = (model: Model): Model => ({
  ...model,
  busy: true,
  currentThreadId: "t",
})

test("covers reducer boundaries and every busy shortcut", () => {
  let model = initial("/work")
  expect(update(model, { _tag: "ThreadSidebarSelectionConfirmed" })).toBe(model)
  model = update(model, { _tag: "AllDetailsToggled" })
  model = update(model, { _tag: "ThreadsReplaced", threads: [] })
  model = update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 9 })
  model = update(model, { _tag: "ScrollMoved", offset: -3 })
  model = update(model, { _tag: "ReasoningToggled", index: 0 })
  model = update(model, { _tag: "PaletteActionConsumed" })
  model = { ...model, busy: true, input: "go", cursor: 2 }
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) }).pendingAction).toEqual({
    _tag: "Cancel",
  })
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) }).pendingAction).toMatchObject({
    _tag: "Steer",
  })
  expect(update(model, { _tag: "KeyPressed", key: key({ name: "return", ctrl: true }) }).pendingAction).toMatchObject({
    _tag: "InterruptAndSend",
  })
})

test("covers palette navigation, actions, mode wrapping, and history boundaries", () => {
  let model = initial("/work", "low")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "m", ctrl: true }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.modePicker.selected).toBe(3)
  expect(model.mode).toBe("low")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  for (const c of "mode") model = update(model, { _tag: "KeyPressed", key: key({ name: c, sequence: c }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.modePicker.open).toBe(true)
  const empty = initial("/work")
  expect(update(empty, { _tag: "KeyPressed", key: key({ name: "up" }) })).toBe(empty)
  expect(inputRows({ ...empty, input: "\n".repeat(12) })).toBe(8)
})

test("replaces queue state without changing transcript blocks and covers remaining input navigation branches", () => {
  const base = {
    ...initial("/work"),
    blocks: [{ _tag: "Notification", title: "N", detail: "d" }],
    history: ["alpha", "beta"],
  } as Model
  const replaced = replaceQueue(base, [
    { id: "new", prompt: "new" },
    { id: "next", prompt: "next" },
  ])
  expect(replaced.blocks).toEqual(base.blocks)
  expect(replaced.queue).toEqual([
    { id: "new", prompt: "new" },
    { id: "next", prompt: "next" },
  ])
  let model = update(base, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.input).toBe("")
  model = { ...model, input: "zzz", cursor: 3, historySearch: "alpha" }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
  expect(model.input).toBe("zzz")
  model = { ...model, input: "", cursor: 0, historySearch: "alpha" }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
  expect(model.input).toBe("alpha")
  expect(isNarrow(initial("/work"))).toBe(false)
  expect(inputRows(initial("/work"))).toBe(1)
})

test("blocks Enter submission while overlays are active", () => {
  const base = { ...initial("/work"), input: "look at ", cursor: 8 }
  expect(canSubmit(base)).toBe(true)
  expect(canSubmit({ ...base, filePicker: { ...base.filePicker, open: true } })).toBe(false)
  expect(canSubmit({ ...base, modePicker: { open: true, selected: 0 } })).toBe(false)
  expect(canSubmit({ ...base, palette: { open: true, query: "", selected: 0 } })).toBe(false)
  expect(canSubmit({ ...base, threadSwitcher: { ...base.threadSwitcher, open: true } })).toBe(false)
  expect(canSubmit({ ...base, shortcutsOpen: true })).toBe(false)
  expect(canSubmit({ ...base, input: "multi\\", cursor: 6 })).toBe(false)
})

test("selecting a file mention inserts it without clearing the composer", () => {
  let model = update(initial("/work"), {
    _tag: "FilesReplaced",
    files: ["src/main.ts"],
  })
  model = { ...model, input: "explain ", cursor: 8 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  expect(canSubmit(model)).toBe(false)
  for (const character of "main")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  expect(model.input).toBe("explain @main")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.input).toBe("explain @src/main.ts ")
  expect(model.filePicker.open).toBe(false)
  expect(canSubmit(model)).toBe(true)
  expect(model.entries).toHaveLength(0)
})

test("quotes a selected file mention containing spaces", () => {
  let model = update(initial("/work"), {
    _tag: "FilesReplaced",
    files: ["docs/read me.md"],
  })
  model = { ...model, input: "read ", cursor: 5 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  for (const character of "read")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.input).toBe('read @"docs/read me.md" ')
})

test("normalizes OpenTUI modifiers and printable keys", () => {
  expect(fromOpenTui({ name: "x", meta: true }).alt).toBe(true)
  expect(fromOpenTui({ name: "x", super: true }).meta).toBe(true)
  expect(fromOpenTui({ name: "x" })).toMatchObject({ sequence: "", eventType: "press" })
  expect(isPrintable(key({ name: "x", sequence: "x" }))).toBe(true)
  expect(isPrintable(key({ name: "x", sequence: "x", ctrl: true }))).toBe(false)
  expect(isPrintable(key({ name: "x", sequence: "x", alt: true }))).toBe(false)
  expect(isPrintable(key({ name: "x", sequence: "x", meta: true }))).toBe(false)
  expect(isPrintable(key({ name: "x", sequence: "" }))).toBe(false)
  expect(isPrintable(key({ name: "x", sequence: "\u001f" }))).toBe(false)
  expect(isPrintable(key({ name: "x", sequence: "\u007f" }))).toBe(false)
})

it("transitions changed files idle to loading to ready and keeps ready on refresh", () => {
  const base = initial("/work")
  expect(base.changedFiles).toEqual({ _tag: "Idle" })
  const loading = update(base, { _tag: "ChangedFilesRequested" })
  expect(loading.changedFiles).toEqual({ _tag: "Loading" })
  const ready = update(loading, {
    _tag: "ChangedFilesReplaced",
    files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }],
  })
  expect(ready.changedFiles._tag).toBe("Ready")
  const requestedAgain = update(ready, { _tag: "ChangedFilesRequested" })
  expect(requestedAgain.changedFiles._tag).toBe("Ready")
  const refreshed = update(requestedAgain, {
    _tag: "ChangedFilesReplaced",
    files: [{ path: "b.ts", status: "A", added: 2, removed: 0 }],
  })
  expect(readyOr(refreshed.changedFiles, []).map((file) => file.path)).toEqual(["b.ts"])
})

it("transitions workspace files and keeps a stale thread preview while the next one loads", () => {
  const base = initial("/work")
  expect(base.filePicker.items).toEqual({ _tag: "Idle" })
  const loading = update(base, { _tag: "FilesRequested" })
  expect(loading.filePicker.items).toEqual({ _tag: "Loading" })
  const ready = update(loading, { _tag: "FilesReplaced", files: ["src/main.ts"] })
  expect(readyOr(ready.filePicker.items, [])).toEqual(["src/main.ts"])
  expect(update(ready, { _tag: "FilesRequested" }).filePicker.items._tag).toBe("Ready")
  const firstPreviewLoading = update(base, { _tag: "ThreadPreviewRequested" })
  expect(firstPreviewLoading.threadPreview).toEqual({ _tag: "Loading" })
  const previous = update(firstPreviewLoading, {
    _tag: "ThreadPreviewLoaded",
    threadId: "thread-0",
    turns: [{ prompt: "previous", units: TranscriptProjection.Projection.empty("preview", "previous").units }],
  })
  const previewLoading = update(previous, { _tag: "ThreadPreviewRequested" })
  expect(previewLoading.threadPreview).toEqual({
    _tag: "Loading",
    previous: {
      threadId: "thread-0",
      turns: [{ prompt: "previous", units: TranscriptProjection.Projection.empty("preview", "previous").units }],
    },
  })
  const previewReady = update(previewLoading, {
    _tag: "ThreadPreviewLoaded",
    threadId: "thread-1",
    turns: [{ prompt: "hi", units: TranscriptProjection.Projection.empty("preview", "hi").units }],
  })
  expect(previewReady.threadPreview._tag).toBe("Ready")
  const opening = update(base, { _tag: "ThreadOpenRequested" })
  expect(opening.threadLoading).toBe(true)
  expect(update(opening, { _tag: "ThreadOpenCompleted" }).threadLoading).toBe(false)
})

it("clamps the sidebar width on change and terminal resize", () => {
  const base = { ...initial("/work"), width: 120, height: 40 }
  expect(update(base, { _tag: "SidebarWidthChanged", width: 200 }).sidebarWidth).toBe(80)
  expect(update(base, { _tag: "SidebarWidthChanged", width: 10 }).sidebarWidth).toBe(24)
  const widened = update(base, { _tag: "SidebarWidthChanged", width: 60 })
  expect(widened.sidebarWidth).toBe(60)
  const shrunk = update(widened, { _tag: "Resized", width: 70, height: 40 })
  expect(shrunk.sidebarWidth).toBe(30)
})
