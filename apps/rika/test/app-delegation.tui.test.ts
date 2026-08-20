import { expect, test } from "vitest"
import { Effect, FileSystem, Schema } from "effect"
import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "runs turns, tools, pickers, and surfaces in one real TUI session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "src/alpha.ts": "alpha", "src/beta.ts": "beta", "README.md": "readme" },
          script: [
            model.text("HARNESS_RESPONSE"),
            model.turn([
              model.binding(
                { module: "processes", operation: "start", input: { command: "printf TOOL_OK" } },
                "ordinary-tool",
              ),
            ]),
            model.text("ORDINARY_COMPLETE"),
            model.text("MENTION_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Say hello."))
        app.pressEnter()
        const first = yield* app.waitFrame("HARNESS_RESPONSE")
        expect(first).toContain("Say hello.")
        yield* app.settled

        yield* Effect.promise(() => app.type("Run an ordinary tool."))
        app.pressEnter()
        const ordinary = yield* app.waitFrame("ORDINARY_COMPLETE")
        expect(ordinary).toContain("printf TOOL_OK")
        expect(ordinary).not.toContain("Allow once")
        expect(ordinary).not.toContain("[pending]")
        yield* app.settled

        yield* Effect.promise(() => app.type("check @"))
        const opened = yield* app.waitFrame("@README.md")
        expect(opened).toContain("@src")
        yield* Effect.promise(() => app.type("alpha"))
        const narrowed = yield* app.waitFrame("@src/alpha.ts")
        expect(narrowed).not.toContain("@README.md")
        app.pressEnter()
        yield* app.waitFrame("check @src/alpha.ts")
        app.pressEnter()
        yield* app.waitFrame("MENTION_COMPLETE")
        yield* app.settled

        app.pressKey("t", { alt: true })
        const tree = yield* app.waitFrame("Files (3)")
        expect(tree).toContain("src/")
        expect(tree).toContain("alpha.ts")
        expect(tree).toContain("README.md")
        app.pressKey("t", { alt: true })
        yield* app.waitGone("Files (")

        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("Balanced default for everyday work")
        app.pressArrow("right")
        yield* app.waitFrame("Deep reasoning for hard tasks")
        app.pressEscape()
        const escaped = yield* app.waitGone("Deep reasoning")
        expect(escaped).toContain("medium")
        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("Balanced default for everyday work")
        app.pressArrow("right")
        yield* app.waitFrame("Deep reasoning for hard tasks")
        app.pressEnter()
        yield* app.waitGone("Deep reasoning")
        expect(yield* app.waitFrame("high")).toContain("high")

        app.pressKey("o", { ctrl: true })
        const palette = yield* app.waitFrame("Command Palette")
        expect(palette).toContain("new thread")
        expect(palette).toContain("switch")
        expect(palette).toContain("toggle fast mode")
        expect(palette).toContain("set max subagents")
        expect(palette).toContain("set max depth")
        expect(palette).toContain("quit")
        yield* Effect.promise(() => app.type("set max depth"))
        app.pressEnter()
        yield* app.waitFrame("Set Max Depth")
        yield* Effect.promise(() => app.type("2"))
        app.pressEnter()
        yield* app.waitFrame("Max depth set to 2")
        const settings = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) => fileSystem.readFileString(workspacePaths(app.workspace).settings)),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        )
        expect(settings).toEqual({ subagents: { maxDepth: 2 } })

        app.pressKey("o", { ctrl: true })
        yield* Effect.promise(() => app.type("usage"))
        app.pressEnter()
        yield* app.waitFrame("Context & Usage")
        app.pressEscape()
        yield* app.waitGone("Context & Usage")

        app.pressKey("o", { ctrl: true })
        yield* Effect.promise(() => app.type("new thread"))
        app.pressEnter()
        expect(yield* app.waitTerminalTitle((title) => title.startsWith("New thread - rika -"))).toContain("New thread")
        const created = yield* app.waitFrame("Welcome to Rika")
        expect(created).not.toContain("MENTION_COMPLETE")
        app.pressKey("t", { ctrl: true })
        const threads = yield* app.waitFrame("Say hello.")
        expect(threads).toContain("New thread")
        app.pressEscape()

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "runs shell input immediately without permission prompts",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [] })

        yield* Effect.promise(() => app.type("$printf '\\101\\114\\114\\117\\127\\105\\104'"))
        app.pressEnter()
        const allowed = yield* app.waitFrame("ALLOWED")
        expect(allowed).not.toContain("Run shell command")
        expect(allowed).not.toContain("Allow once")
        expect(allowed).not.toContain("Deny")

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
