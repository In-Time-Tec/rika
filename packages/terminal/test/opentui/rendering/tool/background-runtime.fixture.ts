import { createTestRenderer } from "@opentui/core/testing"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Context, Effect, FileSystem, Layer } from "effect"
import { expect, test } from "vitest"
import { Surface } from "../../../../src/opentui/surface/service"
import { initial, type Model } from "../../../../src/state/model"
import type { TranscriptBlock } from "../../../../src/state/transcript/model"
import { openTui } from "./detail.fixture"

const shell = (
  id: string,
  command: string,
  status: Extract<TranscriptBlock, { _tag: "ToolCall" }>["status"],
  background: boolean,
): Extract<TranscriptBlock, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id,
  name: "bash",
  input: JSON.stringify({ command }),
  status,
  presentation: { family: "shell", action: "shell", activeLabel: "Running", completeLabel: "Ran" },
  detail: command,
  files: [],
  process: {
    command,
    background,
    workdir: "/work",
    running: status === "running",
  },
})

const channel = (value: number): number => Math.round(value <= 1 ? value * 255 : value)
const ppm = (
  capture: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>,
  width: number,
  height: number,
) => {
  const pixels: Array<string> = []
  for (let y = 0; y < height; y += 1) {
    const cells = (capture.lines[y]?.spans ?? []).flatMap((span) =>
      Array.from(span.text).map((character) => ({ character, span })),
    )
    for (let x = 0; x < width; x += 1) {
      const cell = cells[x]
      const color = cell?.character === " " ? cell.span.bg : cell?.span.fg
      pixels.push(color === undefined ? "0 0 0" : `${channel(color.r)} ${channel(color.g)} ${channel(color.b)}`)
    }
  }
  return `P3\n${width} ${height}\n255\n${pixels.join("\n")}\n`
}

export const backgroundRuntimeTest = () =>
  test("renders mixed foreground, background, successful, and failed commands in OpenTUI", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const width = 100
        const height = 30
        const services = yield* Layer.build(BunServices.layer)
        const fileSystem = Context.get(services, FileSystem.FileSystem)
        const captureDirectory = yield* Config.string("RIKA_BACKGROUND_CAPTURE_DIR").pipe(Config.withDefault(""))
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const blocks: ReadonlyArray<TranscriptBlock> = [
          shell("foreground", "sleep foreground", "running", false),
          { _tag: "Reasoning", text: "Background recovery" },
          shell("background", "sleep background", "running", true),
          { _tag: "Reasoning", text: "Terminal outcomes" },
          shell("success", "printf success", "complete", true),
          { _tag: "Reasoning", text: "Failure outcome" },
          {
            ...shell("failure", "exit 7", "failed", true),
            process: { running: false, background: true, exitCode: 7, workdir: "/work" },
          },
        ]
        const model: Model = {
          ...initial("/work", "high"),
          width,
          height,
          blocks,
          items: blocks.map((_, index) => ({ _tag: "Block", index, id: `block-${index}`, turnId: "turn" })),
        }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toMatch(/[⠀-⣿] \$ sleep foreground/u)
          expect(frame).toContain("⇢ $ sleep background")
          expect(frame).toContain("✓ $ printf success")
          expect(frame).toContain("✕ $ exit 7")
          expect(frame).not.toContain("detached")

          if (captureDirectory !== "") {
            yield* Effect.all([
              fileSystem.writeFileString(`${captureDirectory}/background-recovery.frame.txt`, frame),
              fileSystem.writeFileString(
                `${captureDirectory}/background-recovery.ppm`,
                ppm(setup.captureSpans(), width, height),
              ),
            ])
          }
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }).pipe(Effect.scoped),
    ))
