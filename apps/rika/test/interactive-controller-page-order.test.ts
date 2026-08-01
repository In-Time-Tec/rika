import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { it, expect } from "vitest"
import { thread, entries, initialState } from "./interactive-controller-transcript-fixtures"

it("inserts an older partial Turn page between retained opening and final entries", () => {
  const base = entries("partial", 2)
  const turn = base[0]!.turn
  const entry = (unitKey: string, sequence: number, text: string) => ({
    turn,
    unit: {
      key: unitKey,
      turnId: turn.id,
      order: TranscriptOrdering.unitOrder(unitKey, sequence),
      revision: sequence,
      content: { _tag: "Entry" as const, role: "assistant" as const, text },
    },
    projectionRevision: 222,
    projectionModelPhase: 0,
  })
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [entry("opening", 1, "opening"), entry("final", 222, "final")],
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(selected.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [entry("middle-3", 3, "middle 3"), entry("middle-2", 2, "middle 2")],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(prepended.state.entries.map((value) => value.unit.key)).toEqual(["opening", "middle-2", "middle-3", "final"])
  expect(prepended.state.model.entries.map((value) => value.text)).toEqual(["opening", "middle 2", "middle 3", "final"])
})
