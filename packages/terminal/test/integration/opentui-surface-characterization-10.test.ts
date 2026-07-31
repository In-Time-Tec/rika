import { Renderable } from "@opentui/core"

import { createTestRenderer } from "@opentui/core/testing"

import { expect, test } from "vitest"

import { Data, Effect } from "effect"

import stringWidth from "string-width"

import { Surface, maxMountedTranscriptEntries } from "../../src/opentui/surface/opentui-surface"

import { colors } from "../../src/presentation/terminal/terminal-theme"

import {
  initial,
  loading,
  ready,
  replaceQueue,
  type Model,
  type ThreadItem,
  update,
} from "../../src/state/model/terminal-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const _insertText = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

const styledTextValue = (value: { readonly chunks: ReadonlyArray<{ readonly text: string }> } | string) =>
  typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")

const _streamingShell = (id: string, output?: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: `{"command":"printf ${id}"}`,
  status: "running" as const,
  presentation: {
    family: "shell" as const,
    action: "shell",
    activeLabel: "Running",
    completeLabel: "Ran",
  },
  detail: `printf ${id}`,
  ...(output === undefined ? {} : { output }),
  files: [],
})

const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

for (const historySize of [1, maxMountedTranscriptEntries + 1] as const) {
  test(`keeps composer updates bounded with ${historySize} transcript entries`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
        const entries = Array.from({ length: historySize }, (_, index) => ({
          role: "assistant" as const,
          text: `settled answer ${index}`,
          turnId: `turn-${index}`,
        }))
        const base: Model = { ...initial("/work", "high"), entries }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<Renderable> }
          const mounted = [...state.transcriptChildren]
          for (let index = 0; index < 2; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
          expect(state.transcriptChildren.every((child, index) => child === mounted[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

const _giantSubagentModel = (childCount: number): Model => {
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = blocks.map((block, index) => ({
    _tag: "Block" as const,
    index,
    id: `block-${block.id}`,
    turnId: "turn-1",
    ...(index === 0 ? {} : { parentId: "root-tool" }),
  }))
  return {
    ...initial("/work", "high"),
    blocks,
    items,
    expandedRowKeys: ["tool:root-tool"],
    scrollFollow: false,
  }
}

const _collapsedSubagentModel = (answerCount: number, childCount: number): Model => {
  const entries = Array.from({ length: answerCount }, (_, index) => ({
    role: "assistant" as const,
    text: `answer ${index}`,
    turnId: "turn-1",
  }))
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "running" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = [
    ...entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `answer-${index}`,
      turnId: "turn-1",
    })),
    ...blocks.map((block, index) => ({
      _tag: "Block" as const,
      index,
      id: `block-${block.id}`,
      turnId: "turn-1",
      ...(index === 0 ? {} : { parentId: "root-tool" }),
    })),
  ]
  return {
    ...initial("/work", "high"),
    entries,
    blocks,
    items,
    expandedRowKeys: [],
    scrollFollow: true,
  }
}

for (const panel of ["changed", "workspace"] as const) {
  test(`keeps composer updates bounded with a large ${panel} files sidebar`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40 }))
        const paths = Array.from(
          { length: 10_000 },
          (_, index) => `src/feature-${Math.floor(index / 20)}/file-${index}.ts`,
        )
        const initialModel = initial("/work", "high")
        const base: Model = {
          ...initialModel,
          width: 120,
          height: 40,
          entries: [{ role: "assistant", text: "settled response" }],
          ...(panel === "changed"
            ? {
                changedFilesOpen: true,
                changedFiles: ready(paths.map((path) => ({ path, status: "M", added: 1, removed: 0 }))),
              }
            : {
                workspaceFilesOpen: true,
                filePicker: { ...initialModel.filePicker, items: ready(paths) },
              }),
        }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as {
            readonly changedRows: ReadonlyArray<unknown>
            readonly transcriptChildren: ReadonlyArray<Renderable>
          }
          const sidebarRows = state.changedRows
          expect(surface.changedFilesBox.scrollHeight).toBe(sidebarRows.length)
          expect(surface.changedFilesBox.content.height).toBeLessThanOrEqual(
            surface.changedFilesBox.viewport.height + 1,
          )
          const transcriptChildren = [...state.transcriptChildren]
          for (let index = 0; index < 20; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.changedRows).toBe(sidebarRows)
          expect(state.transcriptChildren.every((child, index) => child === transcriptChildren[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

for (const width of [80, 50] as const) {
  test(`renders a visible error action and leaves the composer usable at width ${width}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height: 20 }))
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
          yield* openTui(() => setup.renderOnce())
          const failed = setup.captureCharFrame()
          expect(failed).toContain("ERROR: Message failed")
          expect(failed.replaceAll(/\s+/g, " ")).toContain("Next: Press Enter to try again.")
          expect(
            setup
              .captureSpans()
              .lines.flatMap((line) => line.spans)
              .some(
                (span) => span.text.includes("ERROR: Message failed") && span.fg.toInts().join(",") === "128,0,0,255",
              ),
          ).toBe(true)
          yield* openTui(() => setup.mockInput.typeText("retry"))
          setup.mockInput.pressEnter()
          expect(model.busy).toBe(true)
          model = update(model, { _tag: "TurnStarted", turnId: "turn-retry", prompt: "retry" })
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          expect(model.entries.at(-1)).toEqual({ role: "user", text: "retry", turnId: "turn-retry" })
          expect(setup.captureCharFrame()).toContain("┃ retry")
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

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
  test(`keeps the animated welcome centered above the bottom composer at ${width}x${height}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          const state = { ...initial("/workspace", "high"), width, height }
          const capturePhases = Effect.fn("capturePhases")(function* (
            remaining: number,
          ): Effect.fn.Return<ReadonlyArray<ReturnType<typeof nonSpaceBounds>>, OpenTuiError> {
            if (remaining === 0) return []
            surface.update(state)
            yield* openTui(() => setup.renderOnce())
            const frame = setup.captureCharFrame()
            expect(frame).toContain("Welcome to Rika")
            expect(frame).not.toMatch(/Threads|Local durable coding agent|▏/)
            expect(frame.split("\n")[height - 5]?.startsWith("╭")).toBe(true)
            expect(frame.split("\n")[height - 1]?.startsWith("╰")).toBe(true)
            return [nonSpaceBounds(frame, height), ...(yield* capturePhases(remaining - 1))]
          })
          const phases = yield* capturePhases(10)
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
      }),
    ))
}

for (const height of [13, 16, 19] as const) {
  test(`keeps essential compact welcome copy visible at 60x${height}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 60, height }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update({ ...initial("/workspace", "high"), width: 60, height })
          yield* openTui(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toContain("Welcome to Rika")
          expect(frame).toContain("ctrl+o commands")
          expect(frame).toContain("? help")
          expect(frame.split("\n")[height - 5]?.startsWith("╭")).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

for (const [width, height] of [
  [140, 40],
  [100, 24],
  [60, 16],
  [59, 14],
  [40, 12],
  [24, 8],
  [20, 8],
  [12, 6],
] as const) {
  test(`bounds responsive surfaces inside a ${width}x${height} terminal`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const queued = replaceQueue(
          {
            ...initial("/work", "high"),
            width,
            height,
            input: "界🙂e\u0301".repeat(12),
            cursor: 60,
            changedFilesOpen: true,
            changedFiles: ready([{ path: "src/界🙂e\u0301.ts", status: "M", added: 2, removed: 1 }]),
            filePicker: {
              open: false,
              query: "",
              selected: 0,
              items: ready(["src/界🙂e\u0301.ts"]),
            },
            threadSidebar: { open: true, focused: true, selected: 0, scrollTop: 0 },
            threads: [thread({ id: "unicode-thread", title: "界🙂e\u0301 thread" })],
          },
          [{ id: "tiny-queue", prompt: "queued 界🙂e\u0301".repeat(10) }],
        )
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        const bounded = (name: string, renderable: { x: number; y: number; width: number; height: number }) => {
          const bounds = { x: renderable.x, y: renderable.y, width: renderable.width, height: renderable.height }
          expect(renderable.x).toBeGreaterThanOrEqual(0)
          expect(renderable.y).toBeGreaterThanOrEqual(0)
          expect(renderable.x + renderable.width, `${name} horizontal ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(
            width,
          )
          expect(renderable.y + renderable.height, `${name} vertical ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(
            height,
          )
        }
        try {
          for (const model of [
            { ...queued, paletteOpen: true, palette: { ...queued.palette, open: true } },
            { ...queued, modePicker: { ...queued.modePicker, open: true } },
            { ...queued, filePicker: { ...queued.filePicker, open: true } },
            { ...queued, filePicker: { ...queued.filePicker, open: true, items: ready([]) } },
            { ...queued, filePicker: { ...queued.filePicker, open: true, items: loading } },
            { ...queued, threadSwitcher: { ...queued.threadSwitcher, open: true } },
          ]) {
            surface.update(model)
            yield* openTui(() => setup.renderOnce())
            bounded("composer", surface.inputBox)
            bounded("queue", surface.queueBox)
            bounded("overlay", surface.paletteBox)
            bounded("content", surface.contentColumn)
            if (model.modePicker.open || model.filePicker.open) {
              expect(surface.paletteBox.x).toBeGreaterThanOrEqual(surface.contentColumn.x)
              expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(
                surface.contentColumn.x + surface.contentColumn.width,
              )
            }
            if (surface.sidebar.visible) bounded("thread sidebar", surface.sidebar)
            if (surface.changedFilesBox.visible) {
              bounded("file sidebar", surface.changedFilesBox)
              const state = surface as unknown as {
                readonly changedRows: ReadonlyArray<{ readonly chunks: ReadonlyArray<{ readonly text: string }> }>
              }
              const innerWidth = Math.max(1, surface.changedFilesBox.width - 6)
              expect(
                state.changedRows.every(
                  (row) => row.chunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0) <= innerWidth,
                ),
              ).toBe(true)
            }
            if (surface.overlayEditor.visible) {
              bounded("overlay editor", surface.overlayEditor)
              expect(surface.overlayEditor.x).toBeGreaterThanOrEqual(surface.paletteBox.x)
              expect(surface.overlayEditor.x + surface.overlayEditor.width).toBeLessThanOrEqual(
                surface.paletteBox.x + surface.paletteBox.width,
              )
            }
            const overlayText = styledTextValue(surface.palette.content)
            const overlayInnerWidth = Math.max(1, surface.paletteBox.width - 4)
            expect(
              overlayText.split("\n").every((line) => stringWidth(line) <= overlayInnerWidth),
              `${width} columns with ${overlayInnerWidth} overlay cells:\n${overlayText}`,
            ).toBe(true)
          }
          surface.showToast("Selection 界👩‍💻e\u0301 copied to clipboard")
          yield* openTui(() => setup.renderOnce())
          bounded("toast", surface.toastBox)
          expect(stringWidth(styledTextValue(surface.toast.content))).toBeLessThanOrEqual(
            Math.max(1, surface.toastBox.width - 4),
          )
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("renders a subagent tool tree and expands each child independently", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 32 }))
      const presentation = {
        agent: {
          family: "agent" as const,
          action: "oracle",
          activeLabel: "Oracle exploring",
          completeLabel: "Oracle has spoken",
        },
        explore: {
          family: "explore" as const,
          action: "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: "file" as const,
        },
        shell: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
      }
      let model: Model = {
        ...initial("/work", "high"),
        width: 80,
        height: 32,
        entries: [
          {
            role: "assistant",
            text: "## Review complete\n\n**No defects found.**",
            turnId: "child:oracle",
          },
        ],
        blocks: [
          {
            _tag: "ToolCall",
            id: "oracle-parent",
            name: "oracle",
            input: '{"prompt":"Review the code"}',
            status: "complete",
            presentation: presentation.agent,
            detail: "Review the code",
            childId: "child:oracle",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-read",
            name: "read",
            input: '{"path":"src/a.ts","offset":2,"limit":3}',
            output: "read child output",
            status: "complete",
            presentation: presentation.explore,
            detail: "src/a.ts L2-4",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-agent",
            name: "task",
            input: '{"prompt":"Explore packages"}',
            status: "complete",
            presentation: {
              family: "agent",
              action: "task",
              activeLabel: "Subagent working",
              completeLabel: "Subagent finished",
            },
            detail:
              "Read-only explore packages/configuration, extensions, and tools. Report concise public responsibilities with source-file evidence.",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-shell",
            name: "bash",
            input: '{"command":"bun test"}',
            output: "shell child output",
            status: "complete",
            presentation: presentation.shell,
            detail: "bun test",
            files: [],
          },
        ],
        items: [
          { _tag: "Block", index: 0, id: "tool:oracle-parent", turnId: "turn" },
          { _tag: "Block", index: 1, id: "tool:child-read", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 2, id: "tool:child-agent", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 3, id: "tool:child-shell", turnId: "child:oracle", parentId: "oracle-parent" },
          {
            _tag: "Entry",
            index: 0,
            id: "assistant:child:oracle:0",
            turnId: "child:oracle",
            parentId: "oracle-parent",
          },
        ],
        expandedRowKeys: ["tool:oracle-parent"],
      }
      const opened: Array<{ readonly path: string; readonly line?: number; readonly column?: number }> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: (target) => opened.push(target),
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly content: {
                    readonly chunks: ReadonlyArray<{
                      readonly text: string
                      readonly fg?: { readonly equals: (other: unknown) => boolean }
                    }>
                  }
                  readonly screenX: number
                  readonly screenY: number
                }
              }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const collapsed = setup.captureCharFrame()
        expect(collapsed).toContain("Oracle has spoken ▾")
        expect(collapsed).toContain("Review the code")
        expect(collapsed).toContain("├ ✓ Read src/a.ts L2-4 ▸")
        expect(collapsed).toContain("├ ✓ Subagent finished ▸")
        expect(collapsed).toContain("├ ✓ $ bun test ▸")
        expect(collapsed).toContain("Review complete")
        expect(collapsed).toContain("No defects found.")
        expect(collapsed).not.toContain("##")
        expect(collapsed).not.toContain("**")
        expect(collapsed).not.toContain("read child output")
        expect(collapsed).not.toContain("shell child output")
        const oracleChunks = records().get("tool:oracle-parent:header")!.renderable.content.chunks
        expect(oracleChunks.find((chunk) => chunk.text.includes("Oracle"))!.fg?.equals(colors.text)).toBe(true)
        expect(oracleChunks.find((chunk) => chunk.text === " has spoken")!.fg?.equals(colors.muted)).toBe(true)
        const readChunks = records().get("tool:child-read:header")!.renderable.content.chunks
        expect(readChunks.find((chunk) => chunk.text.includes("Read"))!.fg?.equals(colors.text)).toBe(true)
        expect(readChunks.find((chunk) => chunk.text === " src/a.ts L2-4")!.fg?.equals(colors.muted)).toBe(true)
        const collapsedLines = collapsed.split("\n")
        const shellRow = collapsedLines.findIndex((line) => line.includes("$ bun test"))
        const responseRow = collapsedLines.findIndex((line) => line.includes("Review complete"))
        expect(responseRow).toBe(shellRow + 3)
        expect(collapsedLines[shellRow + 1]!.trim()).toBe("│")
        expect(collapsedLines[shellRow + 2]!.trim()).toBe("│")
        expect(collapsedLines[responseRow]!.indexOf("Review complete")).toBe(
          collapsedLines[shellRow]!.indexOf("$ bun test"),
        )

        const agent = records().get("tool:child-agent:header")!.renderable
        const agentLines = styledTextValue(agent.content).split("\n")
        expect(agentLines).toHaveLength(1)
        const markerLine = agentLines[0]!
        yield* openTui(() =>
          setup.mockMouse.click(agent.screenX + markerLine.indexOf("▸"), agent.screenY + agentLines.length - 1),
        )
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-agent")

        const agentBody = records().get("tool:child-agent:body")!.renderable
        yield* openTui(() =>
          setup.mockMouse.drag(agentBody.screenX, agentBody.screenY, agentBody.screenX + 24, agentBody.screenY),
        )
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getSelection()?.getSelectedText()).toContain("Read-only explore")
        model = update(model, { _tag: "DetailToggled", id: "tool:oracle-parent" })
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).not.toContain("tool:oracle-parent")
        expect(setup.captureCharFrame()).not.toContain("Read-only explore")
        expect(setup.renderer.getSelection()).toBeNull()
        model = update(model, { _tag: "DetailToggled", id: "tool:oracle-parent" })
        surface.update(model)
        yield* openTui(() => setup.flush())

        const read = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(read.screenX + 4, read.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-read")
        expect(setup.captureCharFrame()).toContain("read child output")
        expect(setup.captureCharFrame()).not.toContain("shell child output")

        yield* openTui(() => setup.mockMouse.click(read.screenX + 12, read.screenY))
        expect(opened).toEqual([{ path: "src/a.ts", line: 3, column: 1 }])
        expect(model.expandedRowKeys).toContain("tool:child-read")

        const shell = records().get("tool:child-shell:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(shell.screenX + 4, shell.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-shell")
        expect(setup.captureCharFrame()).toContain("shell child output")

        const expandedRead = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedRead.screenX + 4, expandedRead.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).not.toContain("tool:child-read")
        expect(setup.captureCharFrame()).not.toContain("read child output")
        expect(setup.captureCharFrame()).toContain("shell child output")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drags the composer top border through OpenTUI mouse routing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
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
        yield* openTui(() => setup.renderOnce())
        expect(surface.inputBox.height).toBe(5)
        expect(model.input).toBe("")
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y))
        expect(pointers.at(-1)).toBe("move")
        yield* openTui(() => setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4))
        yield* openTui(() => setup.renderOnce())
        expect(model.composerHeight).toBe(9)
        expect(surface.inputBox.height).toBe(9)
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y + 1))
        expect(pointers.at(-1)).toBe("default")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
