import { describe, expect, it } from "@effect/vitest"
import { makeHarness, settle } from "./execution-ingest-behavior-support"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

import { Fixtures } from "./execution-ingest-support"
import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"

describe("ExecutionIngest", () => {
  it.effect("notifies committed usage after a zero-cost attempt is observed", () =>
    Effect.gen(function* () {
      const commits: Array<ExecutionIngest.Commit> = []
      const { ingest } = yield* makeHarness({
        script: {
          root: {
            status: "completed",
            events: [
              ExecutionFixtures.started("root"),
              ExecutionFixtures.event("root", "attempt", 1, "model.attempt.completed", {
                data: { model_attempt_id: "attempt-1", cost: { amount: 0, currency: "USD" } },
              }),
              ExecutionFixtures.event("root", "usage", 2, "model.usage.reported", {
                data: {
                  model_attempt_id: "attempt-1",
                  input_tokens: 2,
                  output_tokens: 3,
                },
              }),
              ExecutionFixtures.event("root", "completed", 3, "execution.completed"),
            ],
          },
        },
        onCommitted: (commit) => commits.push(commit),
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      expect(commits.some((commit) => commit.usageChanged)).toBe(true)
      expect(commits.at(-1)).toMatchObject({
        threadId: ExecutionFixtures.threadId,
        rootTurnId: ExecutionFixtures.rootId,
        terminal: true,
        usageChanged: true,
      })
    }),
  )

  it.effect("publishes one anchored global patch for each accepted projection mutation", () =>
    Effect.gen(function* () {
      const { ingest, projectionChanges, projectionWatch, transcripts } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
      })

      expect(projectionWatch.snapshots).toEqual([])
      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      const projectionStarted = projectionChanges.find((change) => change._tag === "ProjectionStarted")
      if (projectionStarted?._tag !== "ProjectionStarted") return yield* Effect.die("projection stream did not start")
      const patches = projectionChanges.flatMap((change) => (change._tag === "ProjectionPatched" ? [change.patch] : []))
      expect(patches.length).toBeGreaterThan(0)
      expect(patches.every((patch) => patch.streamId === projectionStarted.snapshot.streamId)).toBe(true)
      expect(patches.map((patch) => [patch.baseRevision, patch.patchRevision])).toEqual(
        patches.map((_, index) => [index, index + 1]),
      )

      const childAttachment = patches.find(
        (patch) =>
          patch.delta.upsert.some((unit) => unit.turnId === ExecutionFixtures.childId) &&
          patch.delta.upsert.some((unit) => unit.key === "tool:root:call_1"),
      )
      expect(childAttachment).toBeDefined()

      const visible = new Map(projectionStarted.snapshot.units.map((unit) => [unit.key, unit]))
      for (const patch of patches) {
        for (const key of patch.delta.remove) visible.delete(key)
        for (const unit of patch.delta.upsert) visible.set(unit.key, unit)
      }
      const stored = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(
        [...visible.values()].toSorted((left, right) =>
          Fixtures.TranscriptOrdering.compareUnitOrder(left.order, right.order),
        ),
      ).toEqual(stored?.units)
      expect(projectionChanges.at(-1)).toMatchObject({
        _tag: "ProjectionStopped",
        streamId: projectionStarted.snapshot.streamId,
        patchRevision: patches.length,
        status: "completed",
      })
    }),
  )
})
