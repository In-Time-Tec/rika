import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"
import { statusContent } from "../../../src/opentui/surface/content"
import { openTui, styledTextValue } from "../../support/surface/transcript/pane-geometry.fixture"

it.effect("keeps finishing text visible after a non-streamed completion and clears it on terminal completion", () =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 24 }))
    const clock = new ManualClock()
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
    let model: Model = {
      ...initial("/work", "high"),
      width: 120,
      height: 24,
      busy: true,
      activeTurnId: "turn",
      activity: { _tag: "Waiting" },
    }
    try {
      model = update(model, { _tag: "AssistantCompleted", turnId: "turn", text: "Completed without deltas" })
      expect(model.activity).toEqual({ _tag: "Finishing" })
      for (const width of [120, 40, 24, 15, 14, 8, 4, 40, 120]) {
        setup.resize(width, 24)
        model = { ...model, width }
        surface.update(model)
        for (const phase of [0, 1, 2]) {
          if (phase > 0) clock.advance(100)
          yield* openTui(() => setup.renderOnce())
          const footer = setup.captureCharFrame().split("\n")[23] ?? ""
          if (width >= 15) expect(footer, `${width} columns, phase ${phase}`).toMatch(/[∼≈≋] Finishing/)
          else expect(footer).not.toMatch(/[∼≈≋]/)
        }
      }
      model = update(model, { _tag: "ExecutionCompleted", turnId: "turn" })
      surface.update(model)
      clock.advance(100)
      yield* openTui(() => setup.renderOnce())
      expect(setup.captureCharFrame().split("\n")[23]).not.toMatch(/[∼≈≋]|Finishing/)
      expect(model.activity).toBeUndefined()
      expect(model.busy).toBe(false)
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)

it.effect("renders activity and recovery labels together with their icons across mobile and desktop resizes", () =>
  Effect.gen(function* () {
    const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 24 }))
    const clock = new ManualClock()
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
    const connection = { connectivity: "connected" as const, target: "runner" as const, participants: 1 }
    const states: ReadonlyArray<readonly [Partial<Model>, string | undefined]> = [
      [{ activity: { _tag: "Sending" } }, "Sending"],
      [{ activity: { _tag: "Waiting" } }, "Waiting"],
      [{ activity: { _tag: "Thinking", bytes: 0 } }, "Thinking ~0 tok"],
      [{ activity: { _tag: "Streaming", bytes: 16 } }, "Streaming ~4 tok"],
      [{ activity: { _tag: "RunningTools" } }, "Running tools"],
      [{ activity: { _tag: "RunningTools", tools: 2, subagents: 1 } }, "Running 1 subagent, 2 tools"],
      [{ activity: { _tag: "Finishing" } }, "Finishing"],
      [{ activity: { _tag: "Finishing", previous: { _tag: "Streaming", bytes: 0 } } }, "Streaming ~0 tok"],
      [{ activity: { _tag: "Compacting" } }, "Auto-Compacting"],
      [
        { activity: { _tag: "Retrying", attempt: 1, budget: 3, message: "", nextAt: 0 } },
        " — retrying in 0s (attempt 1 of 3)",
      ],
      [{ connection: { ...connection, activity: "prompt-waiting" } }, "Waiting"],
      [{ connection: { ...connection, connectivity: "reconnecting" } }, "Reconnecting"],
      [{ connection: { ...connection, activity: "sandbox-preparing" } }, "Preparing sandbox"],
      [
        {
          activity: { _tag: "Finishing", previous: { _tag: "Streaming", bytes: 100 } },
          connection: { ...connection, activity: "unknown-operation" },
        },
        "Operation status unknown",
      ],
      [{ connection: { ...connection, activity: "approval-required" } }, "Approval required"],
      [{ currentThreadId: "thread", refoldingThreadIds: ["thread"] }, "Rebuilding thread projection"],
      [{ threadLoading: true }, "Loading Thread"],
      [{ activity: { _tag: "Waiting" }, queue: [{ id: "next", prompt: "Run next" }] }, "Waiting"],
      [{ busy: false, queue: [{ id: "next", prompt: "Run next" }] }, undefined],
      [{ busy: false }, undefined],
      [{ busy: true }, undefined],
    ]
    try {
      for (const [state, label] of states) {
        for (const width of [120, 40, 24, 15, 8, 4, 40, 120]) {
          setup.resize(width, 24)
          const model = { ...initial("/work", "high"), busy: true, ...state, width, height: 24 }
          surface.update(model)
          for (const phase of [0, 1, 2]) {
            if (phase > 0) clock.advance(100)
            yield* openTui(() => setup.renderOnce())
            const footer = setup.captureCharFrame().split("\n")[23] ?? ""
            const content = styledTextValue(statusContent(model, phase, 0))
            if (label !== undefined && label.length + 6 <= width) {
              expect(footer, `${label} at ${width}`).toMatch(/[∼≈≋]/)
              expect(footer).toContain(label)
            } else {
              expect(footer, `${label} at ${width}`).not.toMatch(/[∼≈≋]/)
              if (label !== undefined && width > 4) expect(footer).toContain(content.trim())
            }
          }
        }
      }
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  }),
)
