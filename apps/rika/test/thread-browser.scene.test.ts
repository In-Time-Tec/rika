import { expect, test } from "vitest"
import { Scene } from "./scene"

const timeout = 45_000

test(
  "filters durable threads and shows the selected transcript preview",
  () =>
    Scene.run({
      script: [
        Scene.model.text("Alpha response marker."),
        Scene.model.text("Alpha migration prompt."),
        Scene.model.text("Beta response marker."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Alpha migration prompt.\r"),
        Scene.action.writeAfter("Alpha response marker.", "\u000fnew thread\r", 100),
        Scene.action.writeAfter("Loading Thread", "", 300),
        Scene.action.writeAfter("Welcome to Rika", "Beta release prompt.\r"),
        Scene.action.writeAfter("Beta response marker.", "\u0014alpha", 100),
        Scene.action.writeAfter("Alpha migration prompt.", "\u001b\u0003", 300),
      ],
    }).then((result) => {
      expect(result.output).toContain("Thread Preview")
      expect(result.output).toContain("Alpha migration prompt.")
      expect(result.output).toContain("Alpha response marker.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  timeout,
)

test(
  "shows metadata alongside a completed transcript preview",
  () =>
    Scene.run({
      script: [Scene.model.text("Metadata response marker.")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Metadata preview prompt.\r"),
        Scene.action.writeAfter("Metadata response marker.", "\u0014", 100),
        Scene.action.writeAfter("Metadata preview prompt.", "\u001b\u0003", 300),
      ],
    }).then((result) => {
      expect(result.output).toContain("Thread Preview")
      expect(result.output).toContain("Metadata preview prompt.")
      expect(result.output).toContain("idle")
      expect(result.output).toMatch(/rika-scene-[^\s]+\/workspace/)
    }),
  timeout,
)

test(
  "Escape closes the browser without switching the active thread",
  () =>
    Scene.run({
      script: [
        Scene.model.text("First response marker."),
        Scene.model.text("First thread prompt."),
        Scene.model.text("Second response marker."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "First thread prompt.\r"),
        Scene.action.writeAfter("First response marker.", "\u000fnew thread\r", 100),
        Scene.action.writeAfter("Loading Thread", "", 300),
        Scene.action.writeAfter("Welcome to Rika", "Second thread prompt.\r"),
        Scene.action.writeAfter("Second response marker.", "\u0014\u001b[B", 100),
        Scene.action.writeAfter("First thread prompt.", "\u001b", 300),
        Scene.action.writeAfter("response marker.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("First thread prompt.")
      expect(result.output).toContain("Second response marker.")
    }),
  timeout,
)

test(
  "Enter confirms a browser selection and switches the active transcript",
  () =>
    Scene.run({
      script: [
        Scene.model.text("Confirmed response marker."),
        Scene.model.text("Confirmed thread prompt."),
        Scene.model.text("Other response marker."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Confirmed thread prompt.\r"),
        Scene.action.writeAfter("Confirmed response marker.", "\u000fnew thread\r", 100),
        Scene.action.writeAfter("Loading Thread", "", 300),
        Scene.action.writeAfter("Welcome to Rika", "Other thread prompt.\r"),
        Scene.action.writeAfter("Other response marker.", "\u0014\u001b[B\r", 100),
        Scene.action.writeAfter("Loading Thread", "\u0003", 300),
      ],
    }).then((result) => {
      expect(result.output).toContain("Confirmed thread prompt.")
      expect(result.output).toContain("Confirmed response marker.")
    }),
  timeout,
)

test(
  "clears a stale preview when filtering has no matching thread and resets when restored",
  () =>
    Scene.run({
      script: [Scene.model.text("Stale response marker.")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Stale preview prompt.\r"),
        Scene.action.writeAfter("Stale response marker.", "\u0014", 100),
        Scene.action.writeAfter("Stale preview prompt.", "missing-thread", 300),
        Scene.action.writeAfter(
          "No preview",
          "\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f",
          100,
        ),
        Scene.action.writeAfter("Stale preview prompt.", "\u001b\u0003", 300),
      ],
    }).then((result) => {
      expect(result.output.match(/Stale preview prompt\./g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    }),
  timeout,
)

test(
  "switches Threads while a model response is still streaming",
  () =>
    Scene.run({
      script: [Scene.model.text("History response marker."), Scene.model.text("Streaming response marker.", 800)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "History thread prompt.\r"),
        Scene.action.writeAfter("History response marker.", "\u000fnew thread\r", 100),
        Scene.action.writeAfter("Loading Thread", "", 300),
        Scene.action.writeAfter("Welcome to Rika", "Streaming thread prompt.\r"),
        Scene.action.checkRunningAfter("Streaming thread prompt.", "\u0014history\r"),
        Scene.action.writeAfter("History response marker.", "\u0003", 300),
      ],
    }).then((result) => {
      expect(result.runningChecks).toEqual([true])
      expect(result.output).toContain("History response marker.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  timeout,
)
