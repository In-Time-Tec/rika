import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { UnknownJson, awaitTurnStatus, interactivePty, run } from "./client-main-harness"

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
          { after: "› Allow once", ...quit, timeoutMs: 22_000 },
        ],
        yield* blockedTurnScript,
        ["bash"],
        { RIKA_INTERNAL_RESIDENT_GRACE: "20000", RIKA_INTERNAL_RESIDENT_ABANDON: abandonMilliseconds },
      )
      expect(result.timedOut, result.output).toBe(false)
      expect(result.actionsCompleted, result.output).toBe(2)
      yield* awaitTurnStatus(result.database, prompt, "cancelled")
    }),
  )

test(
  "cancels a blocked turn from the quitting client before the process exits",
  () => quitCancelsBlockedTurn("quit from the palette", { write: `${openPalette}quit\r` }, withoutAbandonmentFallback),
  60_000,
)

test(
  "cancels a blocked turn after an interrupted client leaves the resident",
  () => quitCancelsBlockedTurn("quit on SIGINT", { write: "", signal: "SIGINT" }, "500"),
  60_000,
)

test(
  "cancels a blocked turn after a terminated client leaves the resident",
  () => quitCancelsBlockedTurn("quit on SIGTERM", { write: "", signal: "SIGTERM" }, "500"),
  60_000,
)

test(
  "cancels a blocked turn after a hard-killed client stays away",
  () => quitCancelsBlockedTurn("quit on SIGKILL", { write: "", signal: "SIGKILL" }, "500"),
  60_000,
)

test(
  "cancels a blocked turn from the client when its terminal hangs up",
  () => quitCancelsBlockedTurn("quit on SIGHUP", { write: "", signal: "SIGHUP" }, withoutAbandonmentFallback),
  60_000,
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
            { after: "› Allow once", write: "", closePty: true, timeoutMs: 22_000 },
            { after: "", write: "", turnPrompt: prompt, turnStatus: "cancelled", timeoutMs: 22_000 },
          ],
          yield* blockedTurnScript,
          ["bash"],
          { RIKA_INTERNAL_RESIDENT_GRACE: "20000", RIKA_INTERNAL_RESIDENT_ABANDON: withoutAbandonmentFallback },
        )
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted, result.output).toBe(3)
        yield* awaitTurnStatus(result.database, prompt, "cancelled")
      }),
    ),
  60_000,
)
