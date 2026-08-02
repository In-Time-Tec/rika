import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { UnknownJson, interactivePty } from "./client-pty-scenario"
import { awaitTurnStatus } from "./client-turn-status"
import { run } from "./client-process-test-runtime"

const blockedTurnScript = Schema.encodeUnknownEffect(UnknownJson)([
  {
    parts: [
      {
        type: "toolCall",
        name: "bash",
        params: { command: "printf UNAPPROVED" },
        id: "cancel-on-quit",
      },
    ],
    delayMs: 10_000,
  },
  { parts: [{ type: "text", text: "too late" }] },
])

const withoutAbandonmentFallback = "600000"
const openPalette = String.fromCharCode(15)

const quitCancelsBlockedTurn = (
  prompt: string,
  quit: { readonly write: string; readonly signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP" },
  abandonMilliseconds: string,
) =>
  run(
    Effect.gen(function* () {
      const result = yield* interactivePty(
        [
          { after: "Welcome to Rika", write: `${prompt}\r`, timeoutMs: 22_000 },
          { after: "Waiting", ...quit, delayMs: 500, timeoutMs: 22_000 },
        ],
        yield* blockedTurnScript,
        { RIKA_INTERNAL_RESIDENT_GRACE: "20000", RIKA_INTERNAL_RESIDENT_ABANDON: abandonMilliseconds },
      )
      expect(result.timedOut, result.output).toBe(false)
      expect(result.actionsCompleted, result.output).toBe(2)
      expect(result.output).not.toContain("UNAPPROVED")
      yield* awaitTurnStatus(result.database, prompt, "cancelled")
    }),
  )

test(
  "cancels a blocked turn from the quitting client before the process exits",
  () => quitCancelsBlockedTurn("quit from the palette", { write: `${openPalette}quit\r` }, withoutAbandonmentFallback),
  120_000,
)

test(
  "cancels a blocked turn after a terminated client leaves the resident",
  () => quitCancelsBlockedTurn("quit on SIGTERM", { write: "", signal: "SIGTERM" }, "500"),
  120_000,
)

test(
  "cancels a blocked turn after a hard-killed client stays away",
  () => quitCancelsBlockedTurn("quit on SIGKILL", { write: "", signal: "SIGKILL" }, "500"),
  120_000,
)

test(
  "cancels a blocked turn from the client when its terminal hangs up",
  () => quitCancelsBlockedTurn("quit on SIGHUP", { write: "", signal: "SIGHUP" }, withoutAbandonmentFallback),
  120_000,
)

test(
  "cancels a blocked turn from the client when its terminal dies outright",
  () =>
    run(
      Effect.gen(function* () {
        const prompt = "quit on terminal death"
        const result = yield* interactivePty(
          [
            { after: "Welcome to Rika", write: `${prompt}\r`, timeoutMs: 22_000 },
            { after: "Waiting", write: "", closePty: true, delayMs: 500, timeoutMs: 22_000 },
            { after: "", write: "", turnPrompt: prompt, turnStatus: "cancelled", timeoutMs: 22_000 },
          ],
          yield* blockedTurnScript,
          { RIKA_INTERNAL_RESIDENT_GRACE: "20000", RIKA_INTERNAL_RESIDENT_ABANDON: withoutAbandonmentFallback },
        )
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted, result.output).toBe(3)
        expect(result.output).not.toContain("UNAPPROVED")
        yield* awaitTurnStatus(result.database, prompt, "cancelled")
      }),
    ),
  120_000,
)
