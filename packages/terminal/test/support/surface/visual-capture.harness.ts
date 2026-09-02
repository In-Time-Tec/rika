import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { Effect, FileSystem, Path, Schema } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { scenarios } from "./layout.harness"

const visualMetadata = {
  schema: 2,
  terminal: { columns: 80, rows: 24, emulator: "OpenTUI test renderer", font: "cell-grid" },
  theme: { name: "Rika dark", background: "inherited", foreground: "#c9d1d9", surface: "#161b22" },
  native: { opentui: "0.5.10", bun: "1.3.14" },
  masks: [],
  thresholds: { characterDifferences: 0, pixelChannelDelta: 0, differingPixelRatio: 0 },
  pixelModel:
    "deterministic cell raster from OpenTUI captured spans; character cells use foreground and blank cells use background",
  styleModel: "OpenTUI spans serialized as text, RGBA foreground/background, attributes, and cell width",
} as const

type Captured = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

const channel = (value: number): number => Math.round(value <= 1 ? value * 255 : value)
const stableFrame = (frame: string): string => frame.replaceAll(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠿")
const prettyJson = (value: Schema.Json | Captured): string => JSON.stringify(value, undefined, 2)

const screenshot = (capture: Captured, width: number, height: number): string => {
  const pixels: Array<string> = []
  for (let y = 0; y < height; y += 1) {
    const cells = (capture.lines[y]?.spans ?? []).flatMap((span) =>
      Array.from(span.text).map((character) => ({ character, span })),
    )
    for (let x = 0; x < width; x += 1) {
      const cell = cells[x]
      const color = cell?.character === " " ? cell.span.bg : cell?.span.fg
      pixels.push(color !== undefined ? `${channel(color.r)} ${channel(color.g)} ${channel(color.b)}` : "0 0 0")
    }
  }
  return `P3\n${width} ${height}\n255\n${pixels.join("\n")}\n`
}

export const captureVisuals = Effect.fn("Visual.captureVisuals")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fileSystem.makeDirectory(directory, { recursive: true })
  yield* fileSystem.writeFileString(path.join(directory, "metadata.json"), `${prettyJson(visualMetadata)}\n`)
  /** Independent renderers let scenarios render concurrently without sharing frame state. */
  const all = scenarios()
  const lanes = Math.min(4, all.length)
  yield* Effect.forEach(
    Array.from({ length: lanes }, (_, lane) => lane),
    (lane) =>
      Effect.gen(function* () {
        const setup = yield* Effect.acquireRelease(
          Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
          (value) => Effect.sync(() => value.renderer.destroy()),
        )
        for (const [name, source, width, height] of all.filter((_, index) => index % lanes === lane)) {
          const rootBefore = new Set(setup.renderer.root.getChildren())
          const selectionListenersBefore = setup.renderer.listenerCount("selection")
          const clock = new ManualClock()
          const surface = new Surface(
            setup.renderer,
            { key: () => undefined, resize: () => undefined },
            {
              animate: false,
              clock,
            },
          )
          let cleanupError: Error | undefined
          try {
            setup.resize(width, height)
            surface.update({ ...source, width, height })
            yield* Effect.tryPromise(() => setup.flush())
            yield* Effect.tryPromise(() => setup.renderOnce())
            const frame = stableFrame(setup.captureCharFrame())
            const styles = setup.captureSpans()
            yield* Effect.all(
              [
                fileSystem.writeFileString(
                  path.join(directory, `${name}.frame.txt`),
                  `${frame.replaceAll(/ +$/gm, "").trimEnd()}\n`,
                ),
                fileSystem.writeFileString(path.join(directory, `${name}.ppm`), screenshot(styles, width, height)),
                fileSystem.writeFileString(path.join(directory, `${name}.styles.json`), `${prettyJson(styles)}\n`),
              ],
              { concurrency: 3 },
            )
          } finally {
            surface.destroy()
            const retainedRoots = setup.renderer.root.getChildren().filter((child) => !rootBefore.has(child))
            if (retainedRoots.length > 0)
              cleanupError = new Error(`${name} retained ${retainedRoots.length} root renderables`)
            const retainedSelectionListeners = setup.renderer.listenerCount("selection") - selectionListenersBefore
            if (retainedSelectionListeners !== 0)
              cleanupError = new Error(`${name} retained ${retainedSelectionListeners} selection listeners`)
          }
          if (cleanupError !== undefined) throw cleanupError
        }
      }),
    { concurrency: lanes },
  )
})
