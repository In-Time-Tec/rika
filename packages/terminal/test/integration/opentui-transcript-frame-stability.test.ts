import { createTestRenderer, TestRecorder } from "@opentui/core/testing"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import type { ViewportAnchor } from "../../src/presentation/transcript/transcript-viewport-state"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { _collapsedSubagentModel, openTui } from "./opentui-surface-characterization-5-support"

interface ViewportProbe {
  readonly transcriptPane: {
    readonly home: () => void
    readonly pageDown: () => void
  }
  readonly transcriptViewport: {
    readonly mode: { readonly _tag: string; readonly anchor?: ViewportAnchor }
  }
  captureViewportAnchor: () => ViewportAnchor | undefined
  dispatchTranscriptViewport: (
    event:
      | { readonly _tag: "DetachCommanded"; readonly anchor: ViewportAnchor | undefined }
      | { readonly _tag: "AnchorRebased"; readonly anchor: ViewportAnchor },
  ) => void
}

const framesUntilIdle = (recorder: TestRecorder, finalFrame: string) => {
  const frames = recorder.recordedFrames.map(({ frame }) => frame)
  expect(frames.length).toBeGreaterThan(0)
  expect(new Set(frames)).toEqual(new Set([finalFrame]))
}

const detailModel = (block: Model["blocks"][number], expandedRowKey: string): readonly [Model, Model] => {
  const collapsed: Model = {
    ...initial("/work", "medium"),
    blocks: [block],
    items: [{ _tag: "Block", index: 0, id: "detail-item", turnId: "turn-1" }],
  }
  return [collapsed, { ...collapsed, expandedRowKeys: [expandedRowKey] }]
}

const detailCases = [
  [
    "reasoning",
    "reasoning",
    () => detailModel({ _tag: "Reasoning", text: "reasoning\n".repeat(50) }, "block:detail-item"),
  ],
  [
    "shell output",
    "output",
    () =>
      detailModel(
        {
          _tag: "ToolCall",
          id: "shell-detail",
          name: "bash",
          input: '{"command":"printf output"}',
          status: "complete",
          presentation: {
            family: "shell",
            action: "shell",
            activeLabel: "Running",
            completeLabel: "Ran",
          },
          detail: "printf output",
          files: [],
          output: "output\n".repeat(50),
        },
        "tool:shell-detail",
      ),
  ],
  [
    "diff",
    "+added",
    () => detailModel({ _tag: "Diff", path: "src/main.ts", patch: "+added\n".repeat(50) }, "block:detail-item"),
  ],
  [
    "error detail",
    "failure",
    () => detailModel({ _tag: "Error", title: "Failed", detail: "failure\n".repeat(50) }, "block:detail-item"),
  ],
  [
    "authorization input",
    "authorization-input",
    () =>
      detailModel(
        {
          _tag: "AuthorizationCard",
          id: "authorization-detail",
          operation: "Run command",
          capability: "shell",
          input: "authorization-input\n".repeat(50),
          inputTruncated: false,
          status: "pending",
        },
        "block:detail-item",
      ),
  ],
  [
    "cell output",
    "cell-output",
    () =>
      detailModel(
        {
          _tag: "Cell",
          id: "cell-detail",
          status: "complete",
          visual: "shell",
          summary: "Ran cell",
          source: { text: "echo cell-output", lines: 1, truncated: false },
          output: {
            stdout: "cell-output\n".repeat(50),
            stderr: "",
            droppedBytes: 0,
            droppedEvents: 0,
          },
          durationMillis: 1,
          epoch: 1,
          notices: [],
          files: [],
        },
        "cell:cell-detail",
      ),
  ],
] as const

it.effect("publishes an expanded transcript as one settled frame", () =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    const recorder = new TestRecorder(setup.renderer)
    try {
      const collapsed = _collapsedSubagentModel(4, 50)
      surface.update(collapsed)
      yield* openTui(() => setup.flush())

      recorder.rec()
      surface.update({ ...collapsed, expandedRowKeys: ["tool:root-tool"] })
      yield* openTui(() => setup.flush())
      recorder.stop()

      const finalFrame = setup.captureCharFrame()
      framesUntilIdle(recorder, finalFrame)
      expect(finalFrame).toContain("cmd-49")
    } finally {
      recorder.stop()
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)

it.effect.each(detailCases)("publishes expanded %s as one settled frame", ([_, expected, models]) =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    const recorder = new TestRecorder(setup.renderer)
    try {
      const [collapsed, expanded] = models()
      surface.update(collapsed)
      yield* openTui(() => setup.flush())

      recorder.rec()
      surface.update(expanded)
      yield* openTui(() => setup.flush())
      recorder.stop()

      const finalFrame = setup.captureCharFrame()
      framesUntilIdle(recorder, finalFrame)
      expect(finalFrame).toContain(expected)
    } finally {
      recorder.stop()
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)

it.effect("publishes collapse, scroll clamp, anchor fallback, and scrollbar removal in one frame", () =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    const recorder = new TestRecorder(setup.renderer)
    try {
      const collapsed = _collapsedSubagentModel(0, 50)
      surface.update({ ...collapsed, expandedRowKeys: ["tool:root-tool"] })
      yield* openTui(() => setup.flush())
      surface.transcriptScroll.scrollTop = 20
      const probe = surface as unknown as ViewportProbe
      probe.dispatchTranscriptViewport({ _tag: "DetachCommanded", anchor: probe.captureViewportAnchor() })
      yield* openTui(() => setup.flush())
      expect(probe.transcriptViewport.mode._tag).toBe("Anchored")

      recorder.rec()
      surface.update(collapsed)
      yield* openTui(() => setup.flush())
      recorder.stop()

      const finalFrame = setup.captureCharFrame()
      framesUntilIdle(recorder, finalFrame)
      expect(finalFrame).toContain("Subagent working")
      expect(finalFrame).not.toContain("cmd-")
      expect(surface.transcriptScroll.scrollTop).toBe(0)
      expect(surface.transcriptScrollbar.visible).toBe(false)
      expect(probe.transcriptViewport.mode._tag).toBe("Following")
    } finally {
      recorder.stop()
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)

it.effect("rebases an anchor removed by collapse to a surviving transcript row", () =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    const recorder = new TestRecorder(setup.renderer)
    try {
      const source = _collapsedSubagentModel(80, 50)
      const items = source.items as ReadonlyArray<{ readonly _tag: "Block" | "Entry" }>
      const collapsed = {
        ...source,
        items: [...items.filter((item) => item._tag === "Block"), ...items.filter((item) => item._tag === "Entry")],
      }
      surface.update({ ...collapsed, expandedRowKeys: ["tool:root-tool"] })
      yield* openTui(() => setup.flush())
      const probe = surface as unknown as ViewportProbe
      probe.transcriptPane.home()
      yield* openTui(() => setup.flush())
      probe.transcriptPane.pageDown()
      yield* openTui(() => setup.flush())
      const visibleAnchor = probe.captureViewportAnchor()
      expect(visibleAnchor).toBeDefined()
      probe.dispatchTranscriptViewport({ _tag: "AnchorRebased", anchor: visibleAnchor! })
      yield* openTui(() => setup.flush())
      const removedAnchor = probe.transcriptViewport.mode.anchor?.unitId
      expect(removedAnchor).toMatch(/^tool:child-/)

      recorder.rec()
      surface.update(collapsed)
      yield* openTui(() => setup.flush())
      recorder.stop()

      framesUntilIdle(recorder, setup.captureCharFrame())
      expect(probe.transcriptViewport.mode._tag).toBe("Anchored")
      const anchor = probe.transcriptViewport.mode.anchor
      expect(anchor?.unitId).not.toBe(removedAnchor)
      expect(surface.transcriptDiagnostics().keys).toContain(anchor?.unitId)
    } finally {
      recorder.stop()
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)
