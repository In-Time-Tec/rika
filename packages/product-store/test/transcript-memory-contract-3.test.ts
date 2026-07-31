import {
  expect,
  it,
  TranscriptCorrelation,
  TranscriptNestedProjection,
  TranscriptOrdering,
  TranscriptProjection,
  TranscriptUsage,
  Effect,
  Thread,
  TranscriptRepository,
  Turn,
  attachedExecutionCheckpoint,
  commitAll,
  event,
  executionCheckpoint,
  projectionVersion,
  turn,
  unit,
} from "./transcript-memory-behavior-support"

it.layer(TranscriptRepository.memoryLayer)("transcript repository delta contract", (test) => {
  test.effect("fails duplicate and non-intrinsic identities without changing the checkpoint", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(3)
      const initial = { ...TranscriptProjection.Projection.empty(target.id, target.prompt), revision: 0 }
      yield* commitAll(repository, target, initial, undefined)
      const before = yield* repository.get(target.id)
      const duplicate = unit(target.id, 1, 0, "duplicate")
      const duplicateFailure = yield* Effect.result(
        repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState({ ...initial, revision: 1 }),
          { upsert: [duplicate, { ...duplicate, revision: 2 }], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 1 })],
            projectionVersion,
            expectedGeneration: 0,
          },
        ),
      )
      const invalid = { ...unit(target.id, 2, 0, "invalid"), order: TranscriptOrdering.unitOrder("other", 2) }
      const intrinsicFailure = yield* Effect.result(
        repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState({ ...initial, revision: 1 }),
          { upsert: [invalid], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 1 })],
            projectionVersion,
            expectedGeneration: 0,
          },
        ),
      )
      expect(duplicateFailure._tag).toBe("Failure")
      expect(intrinsicFailure._tag).toBe("Failure")
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )

  test.effect("authoritatively refolds an invalidated projection and removes obsolete units", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(4)
      const obsolete = {
        ...TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)]),
        revision: 50,
      }
      yield* commitAll(repository, target, obsolete, undefined, 2)
      const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [event(2)])
      expect(
        yield* repository.replaceForRefold(target, replacement, {
          executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
          projectionVersion,
          expectedProjectionVersion: 2,
          expectedGeneration: 0,
        }),
      ).toMatchObject({ _tag: "Committed" })
      const stored = yield* repository.get(target.id)
      expect(stored?.projectionVersion).toBe(projectionVersion)
      expect(stored?.revision).toBe(replacement.revision)
      expect(stored?.units).toEqual(replacement.units)
      expect(
        yield* repository.replaceForRefold(target, replacement, {
          executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
          projectionVersion,
          expectedProjectionVersion: 2,
          expectedGeneration: 0,
        }),
      ).toEqual({ _tag: "Stale" })
      expect(yield* repository.get(target.id)).toEqual(stored)
    }),
  )

  test.effect("filters every keyset page by exact projection version", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const threadId = Thread.ThreadId.make("thread-version-filter")
      const stale = { ...turn(40, threadId), id: Turn.TurnId.make("turn-filter-stale") }
      const currentOlder = { ...turn(41, threadId), id: Turn.TurnId.make("turn-filter-current-a") }
      const currentNewer = { ...turn(42, threadId), id: Turn.TurnId.make("turn-filter-current-b") }
      for (const [target, version] of [
        [stale, 2],
        [currentOlder, projectionVersion],
        [currentNewer, projectionVersion],
      ] as const)
        yield* commitAll(
          repository,
          target,
          TranscriptProjection.Projection.empty(target.id, target.prompt),
          undefined,
          version,
        )

      const newest = yield* repository.page(threadId, { limit: 1, projectionVersion })
      expect(newest.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
      expect(newest.hasOlder).toBe(true)
      if (newest.oldestCursor === undefined) return yield* Effect.die("filtered page had no oldest cursor")

      const older = yield* repository.page(threadId, {
        before: newest.oldestCursor,
        limit: 1,
        projectionVersion,
      })
      expect(older.entries.map((entry) => entry.turn.id)).toEqual([currentOlder.id])
      expect(older.hasOlder).toBe(false)
      if (older.newestCursor === undefined) return yield* Effect.die("filtered page had no newest cursor")

      const newer = yield* repository.page(threadId, {
        after: older.newestCursor,
        limit: 1,
        projectionVersion,
      })
      expect(newer.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
      expect(newer.hasNewer).toBe(false)
      expect(
        (yield* repository.page(threadId, { limit: 10, projectionVersion: 2 })).entries.map((entry) => entry.turn.id),
      ).toEqual([stale.id])
      expect((yield* repository.page(threadId, { limit: 10, projectionVersion: 4 })).entries).toEqual([])
      expect(new Set((yield* repository.page(threadId, { limit: 10 })).entries.map((entry) => entry.turn.id))).toEqual(
        new Set([stale.id, currentOlder.id, currentNewer.id]),
      )
    }),
  )

  test.effect("keyset-paginates tied turns and nested paths without duplicates or gaps", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const threadId = Thread.ThreadId.make("thread-keyset")
      const targets = [
        { ...turn(10, threadId), id: Turn.TurnId.make("turn-a"), createdAt: 100, updatedAt: 100 },
        { ...turn(11, threadId), id: Turn.TurnId.make("turn-b"), createdAt: 100, updatedAt: 100 },
      ]
      for (const target of targets) {
        const units = [
          unit(target.id, 1, 0, `${target.id}:sequence`),
          unit(target.id, 1, 1, `${target.id}:part-a`),
          unit(target.id, 1, 1, `${target.id}:part-b`),
          unit(target.id, 2, 0, `${target.id}:latest`),
        ]
        yield* commitAll(
          repository,
          target,
          { ...TranscriptProjection.Projection.empty(target.id, target.prompt), units, revision: 2 },
          undefined,
        )
      }
      const collected: Array<TranscriptRepository.Entry> = []
      let cursor: TranscriptRepository.PageCursor | undefined
      while (true) {
        const page = yield* repository.page(threadId, { ...(cursor === undefined ? {} : { before: cursor }), limit: 2 })
        collected.unshift(...page.entries)
        if (!page.hasOlder || page.oldestCursor === undefined) break
        cursor = page.oldestCursor
      }
      expect(collected.map((entry) => entry.unit.key)).toEqual([
        "turn-a:sequence",
        "turn-a:part-a",
        "turn-a:part-b",
        "turn-a:latest",
        "turn-b:sequence",
        "turn-b:part-a",
        "turn-b:part-b",
        "turn-b:latest",
      ])
      expect(new Set(collected.map((entry) => entry.unit.key)).size).toBe(collected.length)
      const newest = yield* repository.page(threadId, { limit: 3 })
      if (newest.oldestCursor === undefined) return yield* Effect.die("newest page had no cursor")
      const older = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 3 })
      if (older.newestCursor === undefined) return yield* Effect.die("older page had no cursor")
      const newer = yield* repository.page(threadId, { after: older.newestCursor, limit: 3 })
      expect(new Set([...older.entries, ...newer.entries].map((entry) => entry.unit.key)).size).toBe(
        older.entries.length + newer.entries.length,
      )
      const olderAgain = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 3 })
      expect(olderAgain.entries.map((entry) => entry.unit.key)).toEqual(older.entries.map((entry) => entry.unit.key))
      expect(
        (yield* Effect.result(
          repository.page(threadId, { before: newest.oldestCursor, after: older.newestCursor, limit: 3 }),
        ))._tag,
      ).toBe("Failure")
    }),
  )

  test.effect("round-trips intrinsic nested order and keeps totals independent of page size", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const threadId = Thread.ThreadId.make("thread-nested")
      const target = turn(20, threadId)
      const childId = "turn-20:child"
      const parent = TranscriptProjection.Projection.project(target.id, target.prompt, [
        {
          cursor: "tool",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: { tool_call_id: "agent", tool_name: "task", input: {} },
        },
      ])
      const child = TranscriptProjection.Projection.project(childId, "", [event(0), event(1)])
      const nested = {
        ...TranscriptNestedProjection.withNestedProjections(parent, [
          { parentId: `${target.id}:agent`, projection: child },
        ]),
        revision: 4,
        costUsd: 1.25,
        pricingVersion: TranscriptUsage.pricingVersion,
        usableCompletionSequence: 3,
      }
      const parentTool = parent.units.find(
        (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
      )
      if (parentTool === undefined) return yield* Effect.die("nested transcript had no parent tool")
      yield* commitAll(repository, target, nested, undefined, projectionVersion, [
        executionCheckpoint(target, nested),
        attachedExecutionCheckpoint(childId, child, TranscriptCorrelation.executionKey(String(target.id)), parentTool),
      ])
      const other = turn(21, threadId)
      yield* commitAll(
        repository,
        other,
        { ...TranscriptProjection.Projection.empty(other.id, other.prompt), revision: 0, costUsd: 2.5 },
        undefined,
      )
      const stored = yield* repository.get(target.id)
      const page = yield* repository.page(threadId, { limit: 1 })
      expect(stored?.units).toEqual(nested.units)
      expect(stored?.pricingVersion).toBe(TranscriptUsage.pricingVersion)
      expect(stored?.usableCompletionSequence).toBe(3)
      expect(page.threadCostUsd).toBe(3.75)
      expect(yield* repository.globalCostUsd).toBe(3.75)
    }),
  )

  test.effect("clamps page limits to one and two hundred", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(30, Thread.ThreadId.make("thread-limits"))
      const units = Array.from({ length: 201 }, (_, index) =>
        unit(target.id, index, 0, `${target.id}:unit-${String(index).padStart(3, "0")}`),
      )
      yield* commitAll(
        repository,
        target,
        { ...TranscriptProjection.Projection.empty(target.id, target.prompt), units, revision: 200 },
        undefined,
      )
      const minimum = yield* repository.page(target.threadId, { limit: 0 })
      const maximum = yield* repository.page(target.threadId, { limit: 999 })
      expect(minimum.entries).toHaveLength(1)
      expect(minimum.hasOlder).toBe(true)
      expect(maximum.entries).toHaveLength(200)
      expect(maximum.hasOlder).toBe(true)
    }),
  )
})
