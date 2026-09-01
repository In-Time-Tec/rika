import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Layer, Path } from "effect"
import { scenarios } from "../../support/surface/layout.harness"
import { captureVisuals } from "../../support/surface/visual-capture.harness"

const removedActivityLabels = [/rivet/i, /semantic[- ]search/i, /ast[- ]grep[- ]outline/i]

test(
  "native character frames and deterministic screenshots match the frozen baseline",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const actual = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-visual-" })
          const approved = path.join(fileURLToPath(new URL("../..", import.meta.url)), "fixtures", "visual")
          yield* captureVisuals(actual)
          const names = (yield* fileSystem.readDirectory(approved)).toSorted()
          expect((yield* fileSystem.readDirectory(actual)).toSorted()).toEqual(names)
          yield* Effect.forEach(names, (name) =>
            Effect.all([
              fileSystem.readFile(path.join(actual, name)),
              fileSystem.readFile(path.join(approved, name)),
            ]).pipe(
              Effect.tap(([actualFile, approvedFile]) =>
                Effect.sync(() => expect(actualFile, name).toEqual(approvedFile)),
              ),
            ),
          )
          const frames = yield* Effect.forEach(
            names.filter((name) => name.endsWith(".frame.txt")),
            (name) => fileSystem.readFileString(path.join(actual, name)),
          )
          for (const frame of frames)
            for (const removedActivity of removedActivityLabels) expect(frame).not.toMatch(removedActivity)
          expect(yield* fileSystem.readFileString(path.join(actual, "tool.frame.txt"))).toContain("⠭ Read src/main.ts")
          const evidenceScenarios = [
            "markdown",
            "diff-complex",
            "edit-streaming",
            "tool-group-states",
            "cancelled-subagent",
            "queued-turn",
            "sidebar",
            "thread-switcher",
            "thread-switcher-stacked",
            "compact-mode-selector",
            "narrow-mode-overlay",
            "narrow-palette-overlay",
            "runner-placement",
            "orb-placement",
            "narrow-orb-placement",
            "narrow-runner-placement",
            "context-meter",
            "meter-scanner",
            "meter-muncher-open",
            "meter-muncher-closed",
            "meter-vacuum",
            "meter-flash",
            "context-details",
            "compact-context-details",
          ]
          for (const scenario of evidenceScenarios) {
            expect(names).toContain(`${scenario}.frame.txt`)
            expect(names).toContain(`${scenario}.styles.json`)
          }
          const styledMarkdown = yield* fileSystem.readFileString(path.join(actual, "markdown.styles.json"))
          expect(styledMarkdown).toContain('"attributes": 1')
          expect(yield* fileSystem.readFileString(path.join(actual, "cancelled-subagent.frame.txt"))).toContain(
            "▾ ⊘ Subagent cancelled\n │   Wait then run the checks\n │   ├   ⊘ $ sleep 60 (cancelled)\n │   │\n │   │\n │   ╰     The subagent was cancelled.",
          )
          const colorScenarios = [
            "mode-picker",
            "diff-complex",
            "tool-group-states",
            "runner-placement",
            "orb-placement",
          ]
          const colorStyles = yield* Effect.forEach(colorScenarios, (scenario) =>
            fileSystem.readFileString(path.join(actual, `${scenario}.styles.json`)),
          )
          for (const styles of colorStyles) {
            expect(new Set(styles.match(/"buffer": \{[^}]+\}/gs) ?? []).size).toBeGreaterThan(2)
          }
          expect(
            yield* fileSystem.readFileString(path.join(actual, "narrow-runner-placement.frame.txt")),
          ).not.toContain("Runner")
          expect(yield* fileSystem.readFileString(path.join(actual, "narrow-orb-placement.frame.txt"))).toContain("Orb")
          expect(scenarios().map(([name]) => name)).not.toContain("semantic-search")
          expect(scenarios().map(([name]) => name)).not.toContain("ast-grep-outline")
        }).pipe(Effect.provide(services))
      }).pipe(Effect.scoped),
    ),
  60_000,
)
