import { Renderable } from "@opentui/core"

import { createTestRenderer } from "@opentui/core/testing"

import { expect, test } from "vitest"

import { Data, Effect } from "effect"

import { Surface } from "../../src/opentui/surface/opentui-surface"
import { maxMountedTranscriptEntries } from "../../src/opentui/rendering/opentui-render-transcript-window"

import { initial, type Model } from "../../src/state/model/terminal-state"
import { ready } from "../../src/state/model/terminal-loadable-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

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
            .some((span) => /[•●·]/u.test(span.text) && span.fg.toInts()[2] > span.fg.toInts()[0])
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
