import { expect, test } from "vitest"
import { Scene } from "./scene"

const up = "\u001b[A"
const down = "\u001b[B"
const escape = "\u001b"
const backspace = "\u007f"
const ctrlE = "\u0005"
const ctrlU = "\u0015"
const ctrlC = "\u0003"

test(
  "navigates from newest to oldest without wrapping at either queue boundary",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("NEWEST_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active turn\r"),
        Scene.action.writeAfter("active turn", "oldest queued\r", 100),
        Scene.action.writeAfter("oldest queued", "newest queued\r", 100),
        Scene.action.writeWhenQueued(2, escape, 500),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", up),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfter("", backspace, 100),
        Scene.action.writeAfter("NEWEST_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("ACTIVE_DONE")
      expect(result.output).toContain("NEWEST_RAN")
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active turn", "newest queued"])
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  40_000,
)

test(
  "Up selects the newest queued row first",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("OLDEST_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active newest selection\r"),
        Scene.action.writeAfter("active newest selection", "oldest remains\r", 100),
        Scene.action.writeAfter("oldest remains", "newest removed\r", 100),
        Scene.action.writeWhenQueued(2, escape, 500),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", backspace),
        Scene.action.writeAfter("OLDEST_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active newest selection", "oldest remains"])
    }),
  40_000,
)

test(
  "Down returns from the newest queued row to the composer where Backspace does not dequeue",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("OLDEST_RAN"), Scene.model.text("NEWEST_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active turn\r"),
        Scene.action.writeAfter("active turn", "oldest queued\r", 100),
        Scene.action.writeAfter("oldest queued", "newest queued\r", 100),
        Scene.action.writeWhenQueued(2, escape, 500),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", down),
        Scene.action.writeAfterVisible("newest queued", backspace),
        Scene.action.writeAfter("NEWEST_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("OLDEST_RAN")
      expect(result.output).toContain("Enter to steer")
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active turn", "oldest queued", "newest queued"])
    }),
  40_000,
)

test(
  "Escape leaves queue navigation without mutating the selected row",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("QUEUED_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active turn\r"),
        Scene.action.writeAfter("active turn", "queued after escape\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", escape),
        Scene.action.writeAfter("", "\r", 100),
        Scene.action.writeAfter("QUEUED_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("QUEUED_RAN")
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active turn", "queued after escape"])
    }),
  40_000,
)

test(
  "Ctrl+E edits the selected queued prompt and Enter saves its revision",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("EDITED_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active turn\r"),
        Scene.action.writeAfter("active turn", "original queued\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", ctrlE),
        Scene.action.writeAfterVisible("Editing queued", `${ctrlU}revised queued\r`),
        Scene.action.writeAfter("EDITED_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("revised queued")
      expect(result.output).toContain("EDITED_RAN")
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active turn", "revised queued"])
    }),
  40_000,
)

test(
  "Enter steers only the selected queued row into the active Turn",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_STEERED", 8_000)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active steer target\r"),
        Scene.action.writeAfter("active steer target", "steer this queued\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", "\r"),
        Scene.action.writeAfter("ACTIVE_STEERED", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active steer target"])
      expect(result.diagnostics).toContain('"rika.resident.command.tag":"SteerQueued"')
      expect(result.output).not.toContain("TestModel script exhausted")
    }),
  40_000,
)

test(
  "Escape cancels a queued edit and restores the original durable prompt",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("CANCELLED_EDIT_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active cancel edit\r"),
        Scene.action.writeAfter("active cancel edit", "keep original queued\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", ctrlE),
        Scene.action.writeAfterVisible("Editing queued", " discarded suffix"),
        Scene.action.writeAfter("", escape, 100),
        Scene.action.writeAfter("CANCELLED_EDIT_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active cancel edit", "keep original queued"])
    }),
  40_000,
)

test(
  "applies successive queued prompt revisions before promotion",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("LATEST_REVISION_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active revisions\r"),
        Scene.action.writeAfter("active revisions", "revision zero\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", ctrlE),
        Scene.action.writeAfterVisible("Editing queued", `${ctrlU}revision one\r`),
        Scene.action.writeWhenQueueRevision("revision one", 2, ctrlE),
        Scene.action.writeAfterVisible("Editing queued", `${ctrlU}revision two\r`),
        Scene.action.writeAfter("LATEST_REVISION_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active revisions", "revision two"])
    }),
  40_000,
)

test(
  "blocks image paste while editing without changing the queued prompt",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("IMAGE_SAFE_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active image guard\r"),
        Scene.action.writeAfter("active image guard", "image-safe queued\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", ctrlE),
        Scene.action.writeAfterVisible("Editing queued", "\u0016"),
        Scene.action.writeAfter("Images cannot be pasted while editing a queued prompt", escape),
        Scene.action.writeAfter("IMAGE_SAFE_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Images cannot be pasted while editing a queued prompt")
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["active image guard", "image-safe queued"])
    }),
  40_000,
)

test(
  "preserves a selected row across a concurrent queue addition and removes that row only",
  () =>
    Scene.run({
      script: [Scene.model.text("ACTIVE_DONE", 8_000), Scene.model.text("FIRST_RAN"), Scene.model.text("THIRD_RAN")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active concurrent queue\r"),
        Scene.action.writeAfter("active concurrent queue", "first queued\r", 100),
        Scene.action.writeAfter("first queued", "selected second queued\r", 100),
        Scene.action.writeWhenQueued(2, escape, 500),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", "concurrent third queued"),
        Scene.action.writeAfterVisible("concurrent third queued", "\r"),
        Scene.action.writeAfterVisibleWhenQueued("concurrent third queued", 3, backspace),
        Scene.action.writeAfter("THIRD_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("FIRST_RAN")
      expect(result.output).toContain("THIRD_RAN")
      expect(result.turns.map((turn) => turn.prompt)).toEqual([
        "active concurrent queue",
        "first queued",
        "concurrent third queued",
      ])
    }),
  40_000,
)

test(
  "drops stale edit state when the selected queued row is promoted concurrently",
  () =>
    Scene.run({
      script: [
        Scene.model.text("ACTIVE_DONE", 8_000),
        Scene.model.text("PROMOTED_RAN", 1_000),
        Scene.model.text("FRESH_RAN"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "active stale row\r"),
        Scene.action.writeAfter("active stale row", "promote while editing\r", 100),
        Scene.action.writeWhenQueued(1, escape, 300),
        Scene.action.writeAfter("", up, 100),
        Scene.action.writeAfterVisible("Enter to steer", ctrlE),
        Scene.action.writeAfterVisible("Editing queued", " unsaved stale text"),
        Scene.action.writeAfter("PROMOTED_RAN", `${ctrlU}fresh after stale\r`, 500),
        Scene.action.writeAfter("FRESH_RAN", `${ctrlC}${ctrlC}`, 500),
      ],
    }).then((result) => {
      expect(result.turns.map((turn) => turn.prompt)).toEqual([
        "active stale row",
        "promote while editing",
        "fresh after stale",
      ])
      expect(result.output).not.toContain("Turn undefined is not queued")
    }),
  40_000,
)
