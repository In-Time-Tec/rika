import { expect, test } from "vitest"
import { Scene } from "./scene"

const page = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}_${String(index).padStart(3, "0")} ${"word ".repeat(12)}`).join(
    "\n",
  )

const expectIsolatedModel = (result: Awaited<ReturnType<typeof Scene.run>>) => {
  expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
}

test(
  "uses Tab, Shift+Tab, and Enter to navigate and toggle transcript details",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.reasoning("REASONING_DETAIL_MARKER"),
          Scene.model.toolCall("shell", { command: "printf", args: ["TOOL_DETAIL_MARKER"] }, "detail-shell"),
        ]),
        Scene.model.text("NAV_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect transcript details.\r"),
        Scene.action.writeAfter("NAV_DONE", "\t\r"),
        Scene.action.writeAfter("REASONING_DETAIL_MARKER", "\t\r"),
        Scene.action.writeAfter("TOOL_DETAIL_MARKER", "\u001b[Z\r\r"),
        Scene.action.writeAfter("REASONING_DETAIL_MARKER", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(5)
      expect(result.output).toContain("REASONING_DETAIL_MARKER")
      expect(result.output).toContain("TOOL_DETAIL_MARKER")
      expectIsolatedModel(result)
    }),
  45_000,
)

test(
  "pages away from the live bottom and End returns to it",
  () =>
    Scene.run({
      script: [Scene.model.text(`${page("PAGE", 120)}\nLIVE_BOTTOM_MARKER`)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Render a long transcript.\r"),
        Scene.action.writeAfter("LIVE_BOTTOM_MARKER", "\u001b[5~"),
        Scene.action.writeAfter("076", "\u001b[F\u0003", 100),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(3)
      expectIsolatedModel(result)
    }),
  45_000,
)

test(
  "keeps a detached reading position while later output streams and End resumes follow",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          ...Array.from({ length: 180 }, (_, index) =>
            Scene.model.textPart(`STREAM_${String(index).padStart(3, "0")}\n`),
          ),
          Scene.model.textPart("DETACH_STREAM_DONE"),
        ]),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Stream a long answer.\r"),
        Scene.action.writeAfter("Streaming", "\u001b[5~", 200),
        Scene.action.writeAfter("STREAM_0", "\u001b[F", 100),
        Scene.action.writeAfter("STREAM_DONE", "\u001b[F", 100),
        Scene.action.writeAfterDelay("\u0003", 500),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(5)
      expectIsolatedModel(result)
    }),
  45_000,
)

test(
  "keeps following streaming output across terminal resize",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          ...Array.from({ length: 180 }, (_, index) =>
            Scene.model.textPart(`RESIZE_FOLLOW_${String(index).padStart(3, "0")} ${"wide ".repeat(16)}\n`),
          ),
          Scene.model.textPart("RESIZE_FOLLOW_DONE"),
        ]),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Stream while resizing.\r"),
        Scene.action.resizeAfter("Streaming", 60, 20),
        Scene.action.resizeAfter("RESIZE_FOLLOW_DONE", 120, 35),
        Scene.action.writeAfterDelay("\u0003", 500),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(4)
      expectIsolatedModel(result)
    }),
  45_000,
)

test(
  "preserves a detached paging anchor across streaming resize",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          ...Array.from({ length: 220 }, (_, index) =>
            Scene.model.textPart(`RESIZE_ANCHOR_${String(index).padStart(3, "0")} ${"anchor ".repeat(10)}\n`),
          ),
          Scene.model.textPart("RESIZE_ANCHOR_DONE"),
        ]),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Hold the reading anchor.\r"),
        Scene.action.writeAfter("100", "\u001b[5~"),
        Scene.action.resizeAfter("RESIZE_ANCHOR_0", 65, 22),
        Scene.action.writeAfter("DONE", "\u001b[F", 100),
        Scene.action.writeAfterDelay("\u0003", 500),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(5)
      expectIsolatedModel(result)
    }),
  45_000,
)

test(
  "click toggles an expandable transcript row",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("shell", { command: "pwd", args: [] }, "click-shell")]),
        Scene.model.text("CLICK_READY"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Render a clickable tool.\r"),
        Scene.action.clickAfter("CLICK_READY", 8, 23),
        Scene.action.writeAfter("/tmp/rika-scene-", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(3)
      expectIsolatedModel(result)
    }),
  45_000,
)

test(
  "pages across the 200-entry mount boundary without losing the live bottom",
  () =>
    Scene.run({
      script: [
        Scene.model.turn(
          Array.from({ length: 81 }, (_, index) => {
            const marker = `MOUNT_BOUND_${String(index).padStart(3, "0")}`
            return [
              Scene.model.reasoning(`MOUNT_REASON_${String(index).padStart(3, "0")}`),
              index % 2 === 0
                ? Scene.model.toolCall("read_file", { path: marker }, `mount-${index}`)
                : Scene.model.toolCall("create_file", { path: marker, content: marker }, `mount-${index}`),
            ]
          }).flat(),
        ),
        Scene.model.text("MOUNT_BOUND_LIVE_BOTTOM"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Render more than the mount bound.\r"),
        Scene.action.writeAfter("MOUNT_BOUND_LIVE_BOTTOM", "\u001b[5~".repeat(9)),
        Scene.action.writeAfter("MOUNT_BOUND_001", "\u001b[F\u0003", 250),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(3)
      expectIsolatedModel(result)
    }),
  60_000,
)
