import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { UnknownJson, interactivePty } from "./client-pty-scenario"
import { run } from "./client-process-test-runtime"

test(
  "cancels a busy turn on Ctrl+C and keeps the interactive TUI running",
  () =>
    run(
      Effect.gen(function* () {
        const script = yield* Schema.encodeUnknownEffect(UnknownJson)([
          {
            parts: [
              {
                type: "toolCall",
                name: "bash",
                params: { command: "sleep 10; touch cancellation-side-effect" },
                id: "cancel-busy-turn",
              },
            ],
          },
          { parts: [{ type: "text", text: "too late" }] },
        ])
        const result = yield* interactivePty(
          [
            { after: "Welcome to Rika", write: "cancel this turn\r" },
            { after: "Runn", write: "\u0003" },
            { after: "(cancelled)", write: "\u0003", checkRunning: true },
          ],
          script,
        )
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted).toBe(3)
        expect(result.runningChecks).toEqual([true])
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).toContain("(cancelled)")
        expect(result.output).toContain(".#*+:")
        expect(result.workspaceFiles).not.toContain("cancellation-side-effect")
        expect(result.clientLogs).not.toContain('"message":"process.failed"')
        expect(result.names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
      }),
    ),
  60_000,
)
