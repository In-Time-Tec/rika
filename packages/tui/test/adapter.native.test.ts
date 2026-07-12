import { CliRenderEvents, Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "bun:test"
import { Surface } from "../src/adapter"
import { initial, ready, replaceQueue, update, type Model } from "../src/view-state"

const insertText = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

test("drags the composer top border through OpenTUI mouse routing", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const pointers: Array<string> = []
  ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
  setup.renderer.setMousePointer = (style) => pointers.push(style)
  let model = initial("/work", "high")
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    composerResize: (height) => {
      model = update(model, { _tag: "ComposerHeightChanged", height })
      surface.update(model)
    },
    resize: () => undefined,
  })
  try {
    surface.update(model)
    await setup.renderOnce()
    expect(surface.inputBox.height).toBe(5)
    expect(model.input).toBe("")
    await setup.mockMouse.moveTo(20, surface.inputBox.y)
    expect(pointers.at(-1)).toBe("move")
    await setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4)
    await setup.renderOnce()
    expect(model.composerHeight).toBe(9)
    expect(surface.inputBox.height).toBe(9)
    await setup.mockMouse.moveTo(20, surface.inputBox.y + 1)
    expect(pointers.at(-1)).toBe("default")
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("keeps the welcome mark renderable stable while typing", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 })
  let model: Model = { ...initial("/work", "high"), width: 100, height: 30 }
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    resize: () => undefined,
  })
  try {
    surface.update(model)
    await setup.renderOnce()
    const before = surface.transcriptChildren[0]
    const beforeContent = before?.content
    expect(before).toBeDefined()
    for (const character of "hello world") {
      model = update(model, {
        _tag: "KeyPressed",
        key: { name: character, ctrl: false, alt: false, meta: false, shift: false, sequence: character },
      })
      surface.update(model)
    }
    await setup.renderOnce()
    expect(surface.transcriptChildren[0]).toBe(before)
    expect(surface.transcriptChildren[0]?.content).toBe(beforeContent)
    expect(setup.captureCharFrame()).toContain("Welcome to Rika")
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("drags the sidebar left border to resize it through OpenTUI mouse routing", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 })
  const pointers: Array<string> = []
  ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
  setup.renderer.setMousePointer = (style) => pointers.push(style)
  let model: Model = {
    ...initial("/work", "high"),
    width: 120,
    height: 30,
    changedFilesOpen: true,
    changedFiles: ready([{ path: "src/a-really-long-file-name-that-truncates.ts", status: "M", added: 1, removed: 0 }]),
  }
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    sidebarResize: (width) => {
      model = update(model, { _tag: "SidebarWidthChanged", width })
      surface.update(model)
    },
    resize: () => undefined,
  })
  try {
    surface.update(model)
    await setup.renderOnce()
    expect(surface.changedFilesBox.visible).toBe(true)
    const borderX = surface.changedFilesBox.x
    await setup.mockMouse.moveTo(borderX, 10)
    expect(pointers.at(-1)).toBe("move")
    const narrowFrame = setup.captureCharFrame()
    expect(narrowFrame).not.toContain("a-really-long-file-name-that-truncates.ts")
    await setup.mockMouse.drag(borderX, 10, borderX - 24, 10)
    await setup.renderOnce()
    expect(model.sidebarWidth).toBe(60)
    expect(surface.changedFilesBox.width).toBe(58)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Changed files (1)")
    expect(frame).toContain("a-really-long-file-name-that-truncates.ts")
    surface.changedFilesBox.focus()
    await setup.renderOnce()
    const focusBlue = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .some((span) => span.text.includes("│") && span.fg.toInts().join(",") === "0,170,255,255")
    expect(focusBlue).toBe(false)
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("routes bracketed multiline paste through the adapter as collapsed text", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let model = initial("/work", "high")
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    paste: (text) => {
      model = insertText(model, text)
      surface.update(model)
    },
    resize: () => undefined,
  })
  try {
    const pasted = "first line\nsecond [literal] line\nthird line"
    surface.update(model)
    await setup.mockInput.pasteBracketedText(pasted)
    expect(model.input).toHaveLength(1)
    expect(model.pastedText[0]?.type === "text" ? model.pastedText[0].value : undefined).toBe(pasted)
    expect(model.pastedText[0]?.label).toBe("[Pasted text #1 +3 lines]")
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("copies trimmed selected transcript text through OSC52", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const copied: Array<string> = []
  setup.renderer.copyToClipboardOSC52 = (text: string) => {
    copied.push(text)
    return true
  }
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  try {
    setup.renderer.emit(CliRenderEvents.SELECTION, { getSelectedText: () => "selected transcript  \n" })
    expect(copied).toEqual(["selected transcript"])
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("renders and scrolls nested changed files within the bordered sidebar", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const opened: Array<string> = []
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    openPath: ({ path }) => opened.push(path),
    resize: () => undefined,
  })
  const changedFiles = Array.from({ length: 30 }, (_, index) => ({
    path: `apps/rika/src/features/feature-${String(index).padStart(2, "0")}.ts`,
    status: "M",
    added: index + 1,
    removed: index,
  }))
  try {
    surface.update({
      ...initial("/work", "high"),
      width: 100,
      height: 24,
      entries: [{ role: "assistant", text: "answer" }],
      changedFilesOpen: true,
      changedFiles: ready(changedFiles),
    })
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await setup.renderOnce()
    const initialFrame = setup.captureCharFrame()
    expect(initialFrame).toContain("Changed files (30)")
    expect(initialFrame).toContain("apps/")
    expect(initialFrame).toContain("  rika/")
    expect(initialFrame).toContain("feature-00.ts")
    expect(initialFrame).not.toContain("feature-29.ts")
    await setup.mockMouse.click(72, 5)
    expect(opened).toEqual(["apps/rika/src/features/feature-00.ts"])
    surface.changedFilesBox.scrollTo(surface.changedFilesBox.scrollHeight - surface.changedFilesBox.viewport.height)
    await setup.renderOnce()
    const scrolledFrame = setup.captureCharFrame()
    expect(scrolledFrame).toContain("feature-29.t +30 -29")
    expect(scrolledFrame.split("\n")[0]?.slice(66)).toStartWith("╭")
    expect(scrolledFrame.split("\n")[23]?.slice(66)).toStartWith("╰")
    expect(scrolledFrame.split("\n")[23]?.slice(0, 66)).toStartWith("╰")
    await setup.mockMouse.click(72, 22)
    expect(opened).toEqual(["apps/rika/src/features/feature-00.ts", "apps/rika/src/features/feature-29.ts"])
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("keeps click rows stable after a clipped wide-character filename", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const opened: Array<string> = []
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    openPath: ({ path }) => opened.push(path),
    resize: () => undefined,
  })
  try {
    surface.update({
      ...initial("/work", "high"),
      width: 100,
      height: 24,
      changedFilesOpen: true,
      changedFiles: ready([
        { path: "a/非常非常非常非常非常非常长的文件名.ts", status: "M", added: 1, removed: 1 },
        { path: "b/after.ts", status: "M", added: 2, removed: 0 },
      ]),
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("+1 -1")
    expect(frame).toContain("after.ts +2 -0")
    await setup.mockMouse.moveTo(72, 4)
    await setup.renderOnce()
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.text.includes("after.ts") && (span.attributes & 8) === 8),
    ).toBe(true)
    await setup.mockMouse.click(72, 4)
    expect(opened).toEqual(["b/after.ts"])
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("escapes control characters without shifting changed-file click rows", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const opened: Array<string> = []
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    openPath: ({ path }) => opened.push(path),
    resize: () => undefined,
  })
  try {
    surface.update({
      ...initial("/work", "high"),
      width: 100,
      height: 24,
      changedFilesOpen: true,
      changedFiles: ready([
        { path: "a-bad\n\tname.ts", status: "M", added: 1, removed: 1 },
        { path: "z-after.ts", status: "M", added: 2, removed: 0 },
      ]),
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("a-bad\\n\\tname.ts +1 -1")
    expect(frame).toContain("z-after.ts +2 -0")
    await setup.mockMouse.click(72, 2)
    expect(opened).toEqual(["z-after.ts"])
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("keeps the mode label and picker grouped with the narrowed composer", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  try {
    surface.update({
      ...initial("/work", "high"),
      width: 100,
      height: 24,
      costUsd: 0.004,
      changedFilesOpen: true,
      changedFiles: ready([{ path: "src/main.ts", status: "M", added: 2, removed: 1 }]),
      modePicker: { open: true, selected: 2 },
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain(" $0.004 ─ high ")
    const composerRight = surface.inputBox.x + surface.inputBox.width
    expect(surface.modeLabel.x + surface.modeLabel.width).toBeLessThanOrEqual(composerRight)
    expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(composerRight)
    expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(surface.changedFilesBox.x)
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

for (const width of [80, 50] as const) {
  test(`renders a visible error action and leaves the composer usable at width ${width}`, async () => {
    const setup = await createTestRenderer({ width, height: 20 })
    let model: Model = { ...initial("/work", "high"), width, height: 20 }
    model = update(model, { _tag: "ExecutionFailed", message: "The model is unavailable." })
    const surface = new Surface(setup.renderer, {
      key: (key) => {
        model = update(model, { _tag: "KeyPressed", key })
        if (key.name === "return" && !key.shift) model = update(model, { _tag: "Submitted" })
        surface.update(model)
      },
      resize: () => undefined,
    })
    try {
      surface.update(model)
      await setup.renderOnce()
      const failed = setup.captureCharFrame()
      expect(failed).toContain("ERROR: Execution failed")
      expect(failed.replaceAll(/\s+/g, " ")).toContain("Next: Edit your prompt and press Enter to try again.")
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some(
            (span) => span.text.includes("ERROR: Execution failed") && span.fg.toInts().join(",") === "128,0,0,255",
          ),
      ).toBe(true)
      await setup.mockInput.typeText("retry")
      setup.mockInput.pressEnter()
      expect(model.busy).toBe(true)
      model = update(model, { _tag: "TurnStarted", turnId: "turn-retry", prompt: "retry" })
      surface.update(model)
      await setup.renderOnce()
      expect(model.entries.at(-1)).toEqual({ role: "user", text: "retry", turnId: "turn-retry" })
      expect(setup.captureCharFrame()).toContain("┃ retry")
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  })
}

test("routes ctrl+v to injected image paste and inserts its attachment path", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let model = initial("/work", "high")
  let calls = 0
  const surface = new Surface(setup.renderer, {
    key: () => undefined,
    pasteImage: () => {
      calls += 1
      model = insertText(model, "[.rika/pasted/paste-1.png]")
      surface.update(model)
    },
    resize: () => undefined,
  })
  try {
    surface.update(model)
    setup.mockInput.pressKey("v", { ctrl: true })
    expect(calls).toBe(1)
    expect(model.input).toBe("[.rika/pasted/paste-1.png]")
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

const nonSpaceBounds = (frame: string, height: number) => {
  const points = frame
    .split("\n")
    .slice(0, height - 5)
    .flatMap((row, y) => Array.from(row, (cell, x) => ({ cell, x, y })))
    .filter(({ cell }) => cell !== " ")
  return {
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    bottom: Math.max(...points.map(({ y }) => y)),
  }
}

for (const [width, height] of [
  [100, 30],
  [80, 24],
  [60, 20],
] as const) {
  test(`keeps the animated welcome centered above the bottom composer at ${width}x${height}`, async () => {
    const setup = await createTestRenderer({ width, height })
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    try {
      const state = { ...initial("/workspace", "high"), width, height }
      const capturePhases = async (remaining: number): Promise<ReadonlyArray<ReturnType<typeof nonSpaceBounds>>> => {
        if (remaining === 0) return []
        surface.update(state)
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Welcome to Rika")
        expect(frame).not.toMatch(/Threads|Local durable coding agent|▏/)
        expect(frame.split("\n")[height - 5]).toStartWith("╭")
        expect(frame.split("\n")[height - 1]).toStartWith("╰")
        return [nonSpaceBounds(frame, height), ...(await capturePhases(remaining - 1))]
      }
      const phases = await capturePhases(10)
      expect(phases.every(({ left, right }) => left >= 0 && right < width)).toBe(true)
      expect(new Set(phases.map(({ top, bottom }) => `${top}:${bottom}`)).size).toBeLessThanOrEqual(2)
      const coloredMark = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => /[•●·]/u.test(span.text) && span.fg.toInts().join(",") === "61,212,255,255")
      expect(coloredMark).toBe(true)
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  })
}

for (const height of [13, 16, 19] as const) {
  test(`keeps essential compact welcome copy visible at 60x${height}`, async () => {
    const setup = await createTestRenderer({ width: 60, height })
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    try {
      surface.update({ ...initial("/workspace", "high"), width: 60, height })
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Welcome to Rika")
      expect(frame).toContain("ctrl+o commands")
      expect(frame).toContain("? help")
      expect(frame.split("\n")[height - 5]).toStartWith("╭")
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  })
}

test("drives keyboard, palette, resize, frame capture, and teardown", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let model: Model = initial("/work", "high")
  const surface = new Surface(setup.renderer, {
    key: (key) => {
      model = update(model, { _tag: "KeyPressed", key })
      if (key.name === "return" && !key.shift) model = update(model, { _tag: "Submitted" })
      surface.update(model)
    },
    resize: (width, height) => {
      model = update(model, { _tag: "Resized", width, height })
      surface.update(model)
    },
  })
  try {
    setup.resize(80, 24)
    surface.update(model)
    await setup.renderOnce()
    const welcome = setup.captureCharFrame()
    expect(welcome).toContain("Welcome to Rika")
    expect(welcome).toContain("ctrl+o for commands")
    expect(welcome).toContain("? for shortcuts")
    expect(welcome).not.toContain("Threads")
    expect(welcome).not.toContain("Local durable coding agent")
    expect(welcome).not.toContain("▏")
    model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts", "docs/SPEC.md"] })
    surface.update(model)
    await setup.mockInput.typeText("@main")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("src/main.ts")
    model = { ...model, input: "", cursor: 0 }
    surface.update(model)
    setup.mockInput.pressKey("s", { ctrl: true })
    await setup.renderOnce()
    const modeFrame = setup.captureCharFrame()
    expect(modeFrame).toContain("GPT-5.6 Sol")
    expect(modeFrame).toContain("Deep reasoning for hard tasks")
    setup.mockInput.pressKey("escape")
    await setup.mockInput.typeText("?")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("toggle this help")
    await setup.mockInput.typeText("?")
    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    model = update(model, { _tag: "TurnStarted", turnId: "turn-hello", prompt: "hello" })
    surface.update(model)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("┃ hello")
    model = update(model, { _tag: "AssistantStreamed", text: "stream" })
    model = update(model, { _tag: "AssistantStreamed", text: "ing" })
    model = update(model, { _tag: "ReasoningStreamed", text: "checking" })
    model = replaceQueue(model, [{ id: "next-task", prompt: "next task" }])
    surface.update(model)
    await setup.renderOnce()
    const streamingFrame = setup.captureCharFrame()
    expect(streamingFrame).toContain("streaming")
    expect(streamingFrame).toContain("next task")
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Command Palette")
    setup.mockInput.pressKey("o", { ctrl: true })
    model = update(model, {
      _tag: "BlockAdded",
      block: { _tag: "ToolCall", id: "1", name: "Read", input: "src/main.ts", status: "running" },
    })
    model = update(model, { _tag: "BlockAdded", block: { _tag: "Diff", path: "src/main.ts", patch: "-old\n+new" } })
    surface.update(model)
    await setup.renderOnce()
    const activityFrame = setup.captureCharFrame()
    expect(activityFrame).toMatch(/[⠿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Exploring 1 file ▸/)
    expect(activityFrame).toContain("Edited src/main.ts +1 -1")
    model = update(model, {
      _tag: "BlockAdded",
      block: { _tag: "Workflow", name: "release", step: "verify", status: "running" },
    })
    model = update(model, {
      _tag: "BlockAdded",
      block: {
        _tag: "ImageAttachment",
        name: "screen.png",
        mediaType: "image/png",
        width: 800,
        height: 600,
        bytes: 1200,
      },
    })
    setup.resize(80, 40)
    surface.update(model)
    await setup.renderOnce()
    const metadataFrame = setup.captureCharFrame()
    expect(metadataFrame).toContain("Workflow release")
    expect(metadataFrame).toContain("screen.png · image/png · 800×600 · 1200 bytes")
    setup.resize(50, 12)
    await setup.renderOnce()
    expect([model.width, model.height]).toEqual([50, 12])
    const retained = Renderable.renderablesByNumber.size
    for (let index = 0; index < 25; index += 1) surface.update(model)
    expect(Renderable.renderablesByNumber.size).toBe(retained)
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("keeps every overlay above the composer at 50x12", async () => {
  const setup = await createTestRenderer({ width: 50, height: 12 })
  let model: Model = { ...initial("/work", "high"), width: 50, height: 12 }
  model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts"] })
  model = update(model, {
    _tag: "ThreadsReplaced",
    threads: [{ id: "thread-2", title: "Release notes", workspace: "/two", active: false, unread: false }],
  })
  const base = model
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  const capture = async (next: Model, title: string, content: string, composerRow = 7) => {
    model = next
    surface.update(model)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const rows = frame.split("\n")
    expect(frame).toContain(title)
    expect(frame).toContain(content)
    expect(rows[composerRow]).toStartWith("╭")
    expect(rows[11]).toStartWith("╰")
  }
  try {
    await capture({ ...base, paletteOpen: true, palette: { ...base.palette, open: true } }, "Command Palette", "run")
    await capture({ ...base, modePicker: { ...base.modePicker, open: true } }, "←→ turn · esc", "GPT-5.6")
    await capture({ ...base, shortcutsOpen: true }, "command palette", "Ctrl+O", 4)
    await capture({ ...base, filePicker: { ...base.filePicker, open: true, kind: "file" } }, "@src", "@src")
    await capture(
      { ...base, filePicker: { ...base.filePicker, open: true, kind: "thread" } },
      "@@Release notes",
      "Release notes",
    )
    await capture({ ...base, threadSwitcher: { ...base.threadSwitcher, open: true } }, "Switch Thread", "Release notes")
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})

test("joins the durable queue to the composer and exposes steering controls", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let model = replaceQueue({ ...initial("/work", "medium"), busy: true, busyStatus: "Streaming" }, [
    { id: "queued-1", prompt: "First queued prompt" },
    { id: "queued-2", prompt: "Selected queued prompt" },
  ])
  model = { ...model, queueSelection: "queued-2" }
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  try {
    surface.update({ ...model, queueSelection: undefined })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Enter to steer · Backspace to dequeue")
    surface.update(model)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const rows = frame.split("\n")
    expect(frame).toContain("First queued prompt")
    expect(frame).toContain("Selected queued prompt")
    expect(frame).toContain("Enter to steer · Backspace to dequeue")
    expect(surface.inputBox.y).toBe(surface.queueBox.y + surface.queueBox.height)
    expect(rows[surface.queueBox.y]).toStartWith("╭")
    expect(rows[surface.inputBox.y]).toStartWith("╭")
    expect(rows[surface.inputBox.y]).toEndWith("╮")
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
})
