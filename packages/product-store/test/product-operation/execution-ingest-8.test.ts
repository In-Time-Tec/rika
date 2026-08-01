import { describe, expect, it } from "@effect/vitest"
import {
  Fixtures,
  Effect,
  threadId,
  rootId,
  childId,
  event,
  rootEvents,
  childEvents,
  makeHarness,
  settle,
} from "./execution-ingest-behavior-support"

describe("ExecutionIngest", () => {
  it.effect("replaces invalidated units only with projections derived from Relay events", () =>
    Effect.gen(function* () {
      const stored = Fixtures.TranscriptProjection.Projection.project("root", "delegate", [
        event("root", "stale", 1, "model.output.completed", { text: "stale projected text" }),
        event("root", "stale-done", 2, "execution.completed"),
      ])
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed" },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const projection = yield* transcripts.get(rootId)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "stale projected text"),
      ).toBe(false)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "child answered"),
      ).toBe(true)
    }),
  )
})
