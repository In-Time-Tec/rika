import { expect, test } from "vitest"
import { Scene } from "./scene"

const isolatedModel = (diagnostics: string) => expect(diagnostics).not.toContain('"rika.model.backend.kind":"provider"')

test(
  "filters and inserts a Unicode file mention without losing the surrounding draft",
  () =>
    Scene.runWarm({
      workspace: {
        "src/plain.ts": "plain",
        "src/überblick.ts": "UNICODE_CONTEXT_MARKER",
      },
      git: true,
      response: "UNICODE_MENTION_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", `Keep  tail${"\u001b[D".repeat(5)}@über`),
        Scene.action.writeAfter("Keep @über tail", "\r", 300),
        Scene.action.writeAfter("src/überblick.ts  tail", "\r"),
        Scene.action.writeAfter("UNICODE_MENTION_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Keep @src/überblick.ts  tail")
      expect(result.output).toContain("UNICODE_MENTION_COMPLETE")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "moves and inserts a filtered file selection",
  () =>
    Scene.runWarm({
      workspace: {
        "src/alpha.ts": "alpha",
        "src/beta.ts": "beta",
        "src/gamma.ts": "gamma",
      },
      git: true,
      response: "FRESH_SELECTION_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "check @.ts"),
        Scene.action.writeAfter("check @.ts", "\u001b[B\r", 300),
        Scene.action.writeAfter("src/beta.ts ", "\r"),
        Scene.action.writeAfter("FRESH_SELECTION_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("check @src/beta.ts ")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "preserves a filtered file draft when completion is cancelled",
  () =>
    Scene.runWarm({
      workspace: { "src/actual.ts": "actual" },
      git: true,
      response: "CANCELLED_PICKER_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "prefix @missing"),
        Scene.action.writeAfter("prefix @missing", "\u001b", 300),
        Scene.action.writeAfter("prefix @missing", " suffix\r", 300),
        Scene.action.writeAfter("CANCELLED_PICKER_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("prefix @missing suffix")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "shows the empty file state and keeps the empty selection inert",
  () =>
    Scene.runWarm({
      workspace: { "sentinel.txt": "sentinel" },
      git: true,
      response: "EMPTY_PICKER_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "empty @definitely-absent"),
        Scene.action.writeAfter("empty @definitely-absent", "\r", 300),
        Scene.action.writeAfter("empty @definitely-absent", "\r"),
        Scene.action.writeAfter("EMPTY_PICKER_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("no matches")
      expect(result.output).toContain("empty @definitely-absent")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "switches from @ to @@ thread completion and submits the inserted thread context",
  () =>
    Scene.run({
      response: "THREAD_MENTION_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Seed mention thread\r"),
        Scene.action.writeAfter("THREAD_MENTION_COMPLETE", "compare @@", 500),
        Scene.action.writeAfter("Mention Thread", "\r", 300),
        Scene.action.writeAfter("compare @@", "\r", 300),
        Scene.action.writeAfter("THREAD_MENTION_COMPLETE", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("Mention Thread")
      expect(result.output).toContain("THREAD_MENTION_COMPLETE")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "returns from @@ to @ with backspace and preserves the surrounding draft",
  () =>
    Scene.run({
      workspace: { "docs/context.md": "context" },
      git: true,
      response: "SWITCH_BACK_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "use @@"),
        Scene.action.writeAfter("Mention Thread", "\u007fcontext"),
        Scene.action.writeAfter("use @context", "\r", 300),
        Scene.action.writeAfter("context.md ", "\r"),
        Scene.action.writeAfter("SWITCH_BACK_COMPLETE", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("use @docs/context.md ")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "shows file loading while a workspace scan is pending and preserves the draft on cancellation",
  () =>
    Scene.runWarm({
      response: "LOADING_PICKER_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "loading @"),
        Scene.action.writeAfter("Loading files", "\u001b", 300),
        Scene.action.writeAfter("loading @", " pending\r", 300),
        Scene.action.writeAfter("LOADING_PICKER_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Loading files")
      expect(result.output).toContain("loading @ pending")
      isolatedModel(result.diagnostics)
    }),
  40_000,
)

test(
  "inserts a quoted file path so context resolution keeps embedded spaces",
  () =>
    Scene.runWarm({
      workspace: { "docs/read me.md": "SPACED_CONTEXT_MARKER" },
      git: true,
      response: "SPACED_CONTEXT_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "resolve @read"),
        Scene.action.writeAfter("resolve @read", "\r", 300),
        Scene.action.writeAfter('docs/read me.md" ', "\r"),
        Scene.action.writeAfter("SPACED_CONTEXT_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain('resolve @"docs/read me.md" ')
      isolatedModel(result.diagnostics)
    }),
  40_000,
)
