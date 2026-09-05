import { createTestRenderer, ManualClock, TestRecorder } from "@opentui/core/testing"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Surface } from "../../../../src/opentui/surface/service"
import type { ViewportAnchor } from "../../../../src/presentation/transcript/viewport/state"
import { initial, type Model } from "../../../../src/state/model"
import { orderedTranscriptItems } from "../../../../src/presentation/transcript/row"
import { _collapsedSubagentModel, openTui } from "../projection.fixture"

class ViewportProbeSurface extends Surface {
  public get viewportMode() {
    return this.transcriptViewport.mode
  }
  public get viewportAnchorUnitId(): string | undefined {
    return this.transcriptViewport.mode._tag === "Anchored" ? this.transcriptViewport.mode.anchor.unitId : undefined
  }
  public detachViewport(): void {
    this.dispatchTranscriptViewport({ _tag: "DetachCommanded", anchor: this.captureViewportAnchor() })
  }
  public rebaseViewport(anchor: ViewportAnchor): void {
    this.dispatchTranscriptViewport({ _tag: "AnchorRebased", anchor })
  }
  public viewportAnchor(): ViewportAnchor | undefined {
    return this.captureViewportAnchor()
  }
  public viewportHome(): void {
    this.transcriptPane.home()
  }
  public viewportPageDown(): void {
    this.transcriptPane.pageDown()
  }
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
          result: "output\n".repeat(50),
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
] as const

it.effect("publishes an expanded transcript as one settled frame", () =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
    const surface = new ViewportProbeSurface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock: new ManualClock() },
    )
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
    const surface = new Surface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock: new ManualClock() },
    )
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
    const surface = new ViewportProbeSurface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock: new ManualClock() },
    )
    const recorder = new TestRecorder(setup.renderer)
    try {
      const collapsed = _collapsedSubagentModel(0, 50)
      surface.update({ ...collapsed, expandedRowKeys: ["tool:root-tool"] })
      yield* openTui(() => setup.flush())
      surface.transcriptScroll.scrollTop = 20
      surface.detachViewport()
      yield* openTui(() => setup.flush())
      expect(surface.viewportMode._tag).toBe("Anchored")

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
      expect(surface.viewportMode._tag).toBe("Following")
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
    const surface = new ViewportProbeSurface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock: new ManualClock() },
    )
    const recorder = new TestRecorder(setup.renderer)
    try {
      const source = _collapsedSubagentModel(80, 50)
      const items = orderedTranscriptItems(source)
      const collapsed = {
        ...source,
        items: [...items.filter((item) => item._tag === "Block"), ...items.filter((item) => item._tag === "Entry")],
      }
      surface.update({ ...collapsed, expandedRowKeys: ["tool:root-tool"] })
      yield* openTui(() => setup.flush())
      surface.viewportHome()
      yield* openTui(() => setup.flush())
      surface.viewportPageDown()
      yield* openTui(() => setup.flush())
      const visibleAnchor = surface.viewportAnchor()
      expect(visibleAnchor).toBeDefined()
      if (visibleAnchor === undefined) throw new Error("Expected a visible transcript anchor")
      surface.rebaseViewport(visibleAnchor)
      yield* openTui(() => setup.flush())
      const removedAnchor = surface.viewportAnchorUnitId
      expect(removedAnchor).toMatch(/^tool:child-/)

      recorder.rec()
      surface.update(collapsed)
      yield* openTui(() => setup.flush())
      recorder.stop()

      framesUntilIdle(recorder, setup.captureCharFrame())
      expect(surface.viewportMode._tag).toBe("Anchored")
      const anchorUnitId = surface.viewportAnchorUnitId
      expect(anchorUnitId).not.toBe(removedAnchor)
      expect(surface.transcriptDiagnostics().keys).toContain(anchorUnitId)
    } finally {
      recorder.stop()
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)
