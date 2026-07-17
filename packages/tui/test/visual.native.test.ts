import { expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path } from "effect"
import { captureVisuals, scenarios } from "./visual.capture"

const removedActivityLabels = [/rivet/i, /semantic[- ]search/i, /ast[- ]grep[- ]outline/i]

test("native character frames and deterministic screenshots match the frozen baseline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Layer.build(BunServices.layer)
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const actual = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-visual-" })
        const approved = path.join(import.meta.dir, "fixtures", "visual")
        yield* captureVisuals(actual)
        const names = (yield* fileSystem.readDirectory(approved)).toSorted()
        expect((yield* fileSystem.readDirectory(actual)).toSorted()).toEqual(names)
        yield* Effect.forEach(names, (name) =>
          Effect.all([
            fileSystem.readFile(path.join(actual, name)),
            fileSystem.readFile(path.join(approved, name)),
          ]).pipe(
            Effect.tap(([actualFile, approvedFile]) => Effect.sync(() => expect(actualFile).toEqual(approvedFile))),
          ),
        )
        const frames = yield* Effect.forEach(
          names.filter((name) => name.endsWith(".frame.txt")),
          (name) => fileSystem.readFileString(path.join(actual, name)),
        )
        for (const frame of frames)
          for (const removedActivity of removedActivityLabels) expect(frame).not.toMatch(removedActivity)
        expect(yield* fileSystem.readFileString(path.join(actual, "tool.frame.txt"))).toContain("⠭ Exploring 1 file ▸")
        const evidenceScenarios = [
          "markdown",
          "diff-complex",
          "tool-group-states",
          "queued-turn",
          "permission",
          "sidebar",
          "thread-switcher",
          "thread-switcher-stacked",
          "narrow-mode-overlay",
          "narrow-palette-overlay",
          "narrow-permission",
        ]
        for (const scenario of evidenceScenarios) {
          expect(names).toContain(`${scenario}.frame.txt`)
          expect(names).toContain(`${scenario}.styles.json`)
        }
        const styledMarkdown = yield* fileSystem.readFileString(path.join(actual, "markdown.styles.json"))
        expect(styledMarkdown).toContain('"attributes": 1')
        const colorScenarios = ["mode-picker", "permission", "diff-complex", "tool-group-states"]
        const colorStyles = yield* Effect.forEach(colorScenarios, (scenario) =>
          fileSystem.readFileString(path.join(actual, `${scenario}.styles.json`)),
        )
        for (const styles of colorStyles) {
          expect(new Set(styles.match(/"buffer": \{[^}]+\}/gs) ?? []).size).toBeGreaterThan(2)
        }
        expect(scenarios().map(([name]) => name)).not.toContain("semantic-search")
        expect(scenarios().map(([name]) => name)).not.toContain("ast-grep-outline")
      }).pipe(Effect.provide(services))
    }).pipe(Effect.scoped),
  ))
