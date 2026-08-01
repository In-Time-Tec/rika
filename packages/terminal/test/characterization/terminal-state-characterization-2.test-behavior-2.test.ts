import { expect, test } from "vitest"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { ViewState } from "../support/terminal-state-access"
import { key, thread } from "./terminal-state-characterization-2-support"
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
test("closes the thread switcher without reloading the current thread", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second" })],
  })
  model = ViewState.update(model, { _tag: "ThreadActivated", threadId: "b", title: "Second" })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })

  expect(model.threadSwitcher.open).toBe(false)
  expect(model.pendingAction).toBeUndefined()
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
    turns: [
      { prompt: "stale preview", units: TranscriptProjection.Projection.empty("preview", "stale preview").units },
    ],
  })
  for (const character of "missing")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  expect(model.threadPreview._tag).toBe("Idle")

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
  model = ViewState.update(model, {
    _tag: "ThreadPreviewLoaded",
    threadId: "a",
    turns: [
      { prompt: "removed preview", units: TranscriptProjection.Projection.empty("preview", "removed preview").units },
    ],
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
  model = ViewState.update(model, { _tag: "FilesFailed", message: "workspace search failed" })
  expect(model.filePicker.items).toEqual({ _tag: "Idle" })
  expect(model.filePicker.error).toBe("workspace search failed")
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
test("keeps the current thread selected in the sidebar without reloading it", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second" })],
  })
  model = ViewState.update(model, { _tag: "ThreadActivated", threadId: "b", title: "Second" })
  model = ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed", index: 1 })

  expect(model.threadSidebar.selected).toBe(1)
  expect(model.pendingAction).toBeUndefined()
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
