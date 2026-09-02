import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect, FileSystem, Schema } from "effect"
import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

/** Exercises pending interactive actions through one real TUI process. */
const tuiTestTimeout = 60_000

test(
  "runs turns, tools, pickers, and surfaces in one real TUI session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "src/alpha.ts": "alpha", "src/beta.ts": "beta", "README.md": "readme" },
          script: [
            model.text("HARNESS_RESPONSE"),
            model.turn([model.tool("bash", { command: "printf TOOL_OK" }, "ordinary-tool")]),
            model.text("ORDINARY_COMPLETE"),
            model.text("MENTION_COMPLETE"),
          ],
        })
        yield* Effect.tryPromise(() => app.type("Say hello."))
        app.pressEnter()
        const first = yield* app.waitFrame("HARNESS_RESPONSE")
        expect(first).toContain("Say hello.")
        yield* app.settled

        yield* Effect.tryPromise(() => app.type("Run an ordinary tool."))
        app.pressEnter()
        const ordinary = yield* app.waitFrame("ORDINARY_COMPLETE")
        expect(ordinary).toContain("printf TOOL_OK")
        expect(ordinary).not.toContain("Allow once")
        expect(ordinary).not.toContain("[pending]")
        yield* app.settled
        const ordinaryTranscript = yield* app.transcript(Turn.TurnId.make("tui-turn-1"))
        const ordinaryTool = ordinaryTranscript?.units.find(
          (unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "ToolCall" &&
            unit.content.block.name === "bash",
        )
        expect(ordinaryTool?.content._tag === "Block" ? ordinaryTool.content.block : undefined).not.toHaveProperty(
          "notices",
        )
        app.pressKey("\t")
        app.pressEnter()
        const expandedTool = yield* app.waitFrame("TOOL_OK")
        expect(expandedTool).not.toContain("rika.tool.context.current")
        expect(expandedTool).not.toContain("rika.tool.processes.start running")
        expect(expandedTool).not.toContain("rika.tool.processes.start succeeded")

        yield* Effect.tryPromise(() => app.type("check @"))
        const opened = yield* app.waitFrame("@README.md")
        expect(opened).toContain("@src")
        yield* Effect.tryPromise(() => app.type("alpha"))
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
        expect(palette.replace(/\s+/g, " ")).toContain("thread new")
        expect(palette).not.toContain("new on Runner")
        expect(palette).toContain("switch")
        expect(palette).toContain("toggle fast mode")
        expect(palette).toContain("set max subagents")
        expect(palette).toContain("set max depth")
        expect(palette).toContain("quit")
        yield* Effect.tryPromise(() => app.type("set max depth"))
        app.pressEnter()
        yield* app.waitFrame("Set Max Depth")
        yield* Effect.tryPromise(() => app.type("2"))
        app.pressEnter()
        yield* app.waitFrame("Max depth set to 2")
        const settings = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) => fileSystem.readFileString(workspacePaths(app.workspace).settings)),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        )
        expect(settings).toEqual({ subagents: { maxDepth: 2 } })

        app.pressKey("o", { ctrl: true })
        yield* Effect.tryPromise(() => app.type("usage"))
        app.pressEnter()
        yield* app.waitFrame("Context & Usage")
        app.pressEscape()
        yield* app.waitGone("Context & Usage")

        app.pressKey("o", { ctrl: true })
        yield* Effect.tryPromise(() => app.type("thread new"))
        app.pressEnter()
        expect(yield* app.waitTerminalTitle((title) => title.startsWith("New thread - rika -"))).toContain("New thread")
        const created = yield* app.waitFrame("Welcome to Rika")
        expect(created).not.toContain("MENTION_COMPLETE")
        app.pressKey("t", { ctrl: true })
        // The harness title lane answers "idle", so the first Thread carries that generated title, not its prompt.
        const threads = yield* app.waitFrame("Thread Preview")
        expect(threads).toContain("New thread")
        expect(threads).toContain("idle")
        expect(threads).not.toContain("Say hello.")
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

        yield* Effect.tryPromise(() => app.type("$printf '\\101\\114\\114\\117\\127\\105\\104'"))
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
