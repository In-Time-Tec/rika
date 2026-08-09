import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { UnknownJson, interactivePty } from "./client-pty-scenario"
import { run } from "./client-process-test-runtime"

const sideEffect = "cancellation-side-effect"

/**
 * The cell must still be running when Ctrl+C arrives and must only create the file at the end, so
 * cancellation is proven by the absence of a side effect the same cell demonstrably does perform
 * when it is allowed to finish.
 */
const cell = (seconds: number) => `await rika.processes.start({"command":"sleep ${seconds}; touch ${sideEffect}"})`

const scriptFor = (seconds: number) =>
  Schema.encodeUnknownEffect(UnknownJson)([
    {
      parts: [{ type: "toolCall", name: "typescript", params: { code: cell(seconds) }, id: "cancel-busy-turn" }],
    },
    { parts: [{ type: "text", text: "too late" }] },
  ])

test(
  "cancels a busy turn on Ctrl+C and keeps the interactive TUI running",
  () =>
    run(
      Effect.gen(function* () {
        const script = yield* scriptFor(10)
        const result = yield* interactivePty(
          [
            { after: "Welcome to Rika", write: "cancel this turn\r" },
            { after: "Runn", write: "\u0003", timeoutMs: 30_000 },
            { after: "(cancelled)", write: "\u0003", checkRunning: true, timeoutMs: 30_000 },
          ],
          script,
        )
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted).toBe(3)
        expect(result.runningChecks).toEqual([true])
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).toContain("(cancelled)")
        expect(result.output).toContain(".#*+:")
        expect(result.workspaceFiles).not.toContain(sideEffect)
        expect(result.clientLogs).not.toContain('"message":"process.failed"')
        expect(result.names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
      }),
    ),
  60_000,
)

test(
  "lets the same uncancelled cell land its side effect",
  () =>
    run(
      Effect.gen(function* () {
        const script = yield* scriptFor(1)
        const result = yield* interactivePty(
          [
            { after: "Welcome to Rika", write: "let this turn finish\r" },
            { after: "too late", write: "\u0003", checkRunning: true, timeoutMs: 30_000 },
          ],
          script,
        )
        expect(result.timedOut, result.output).toBe(false)
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).not.toContain("(cancelled)")
        expect(result.workspaceFiles, "the cell really does create the file when it completes").toContain(sideEffect)
      }),
    ),
  60_000,
)
