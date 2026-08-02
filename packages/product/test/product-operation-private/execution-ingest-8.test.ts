import { describe, expect, it } from "@effect/vitest"
import { makeHarness, settle } from "./execution-ingest-behavior-support"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

import { Fixtures } from "./execution-ingest-support"
import { Effect } from "effect"

describe("ExecutionIngest", () => {
  it.effect("replaces invalidated units only with projections derived from Relay events", () =>
    Effect.gen(function* () {
      const stored = Fixtures.TranscriptProjection.Projection.project("root", "delegate", [
        ExecutionFixtures.event("root", "stale", 1, "model.output.completed", { text: "stale projected text" }),
        ExecutionFixtures.event("root", "stale-done", 2, "execution.completed"),
      ])
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed" },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
        stored,
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      const projection = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "stale projected text"),
      ).toBe(false)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "child answered"),
      ).toBe(true)
    }),
  )
})
