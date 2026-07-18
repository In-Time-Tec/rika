import { describe, expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { run, runCommand, runTest, sandbox } from "./process"

const helper = new URL("native-pty.py", import.meta.url).pathname
const IdleResultJson = Schema.fromJsonString(Schema.Struct({ capture: Schema.String, submitted: Schema.Boolean }))
const SubmissionResultJson = Schema.fromJsonString(
  Schema.Struct({
    capture: Schema.String,
    pasteCollapsed: Schema.Boolean,
    submitted: Schema.Boolean,
    exited: Schema.Boolean,
    termiosRestored: Schema.Boolean,
  }),
)

const runPty = (context: Effect.Effect.Success<typeof sandbox>, mode?: string) =>
  runCommand(
    context,
    "python3",
    [
      helper,
      context.binary,
      context.workspace,
      Schema.encodeSync(Schema.UnknownFromJsonString)({
        ...context.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      }),
      ...(mode === undefined ? [] : [mode]),
    ],
    { timeout: 20_000 },
  )

describe("packaged TUI in a native PTY", () => {
  test(
    "starts idle without replaying durable history or invoking the configured test model",
    () =>
      runTest(
        Effect.acquireUseRelease(
          sandbox,
          (context) =>
            Effect.gen(function* () {
              expect((yield* run(context, ["run", "historical prompt"])).stdout).toContain("deterministic response")
              const result = Schema.decodeUnknownSync(IdleResultJson)((yield* runPty(context, "idle")).stdout)
              const capture = Buffer.from(result.capture, "base64").toString("utf8")
              expect(result.submitted).toBe(false)
              expect(capture).toContain("Welcome to Rika")
              expect(capture).not.toContain("historical prompt")
              expect(capture).not.toContain("deterministic response")
              expect(capture).not.toContain("Execution failed")
            }),
          (context) => context.dispose,
        ),
      ),
    25_000,
  )

  test(
    "collapses bracketed multiline paste, submits it, and restores terminal state after SIGINT",
    () =>
      runTest(
        Effect.acquireUseRelease(
          sandbox,
          (context) =>
            Effect.gen(function* () {
              const result = Schema.decodeUnknownSync(SubmissionResultJson)((yield* runPty(context)).stdout)
              const capture = Buffer.from(result.capture, "base64").toString("utf8")
              expect(result.pasteCollapsed).toBe(true)
              expect(result.submitted).toBe(true)
              expect(capture).toContain("Welcome to Rika")
              expect(capture).toContain("[Pasted text #1 +2 lines]")
              expect(capture).toContain("deterministic response")
              expect(capture).not.toContain("ExecutionBackendError")
              expect(capture).not.toContain("Execution failed")
              expect(capture).not.toContain("requires Crypto")
              expect(result.exited).toBe(true)
              expect(result.termiosRestored).toBe(true)
              for (const sequence of ["\u001b[?1049h", "\u001b[?25l", "\u001b[?2004h", "\u001b[?1000h"])
                expect(capture).toContain(sequence)
            }),
          (context) => context.dispose,
        ),
      ),
    25_000,
  )
})
