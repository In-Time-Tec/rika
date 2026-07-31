import * as Transcript from "@rika/transcript/transcript-unit"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript-repository"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "@rika/product/turn-record"
import {
  attachedExecutionCheckpoint,
  commitAll,
  event,
  executionCheckpoint,
  invalidCheckpointGraphs,
  nestedProjection,
  projectionVersion,
  turn,
  unit,
} from "./transcript-repository-fixtures"

const compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

it.effect("lists terminal roots whose current projection has an unfinished child", () =>
  Effect.gen(function* () {
    const target = turn(700)
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    const nested = nestedProjection(target, "child:turn-700:parent")

    expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([
      { threadId: target.threadId, turnId: target.id },
    ])
    expect(
      yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
    ).toBe("committed")
    expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([
      { threadId: target.threadId, turnId: target.id },
    ])

    const stored = yield* repository.get(target.id)
    if (stored === undefined) return yield* Effect.die("nested projection was not stored")
    const terminal = nested.checkpoints.map((checkpoint) =>
      checkpoint.attachment === undefined ? checkpoint : { ...checkpoint, status: "completed" as const },
    )
    expect(
      yield* repository.commitDelta(
        target,
        Transcript.projectionState(nested.projection),
        { upsert: [], remove: [] },
        {
          executionCheckpoints: terminal,
          projectionVersion,
          expectedGeneration: stored.checkpointGeneration,
        },
      ),
    ).toBe("committed")
    expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([])
  }),
)

it.effect("loads a migration-invalidated empty projection for authoritative refold", () =>
  Effect.gen(function* () {
    const target = turn(0)
    const invalidated: TranscriptRepository.Projection = {
      turn: target,
      units: [],
      checkpointGeneration: 4,
      revision: 9,
      modelPhase: -1,
      usableCompletionSequence: undefined,
      oldestCursor: undefined,
      checkpointCursor: undefined,
      costUsd: undefined,
      usageCursors: undefined,
      pricingVersion: undefined,
      executionCheckpoints: [],
      projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
    }
    const repository = yield* TranscriptRepository.makeMemory({ initial: [invalidated] })
    expect(yield* repository.get(target.id)).toEqual(invalidated)
    expect(
      (yield* Effect.result(TranscriptRepository.makeMemory({ initial: [{ ...invalidated, revision: -2 }] })))._tag,
    ).toBe("Failure")

    const replacement = Transcript.project(target.id, target.prompt, [event(0), event(1), event(2)])
    expect(
      yield* repository.replaceForRefold(target, replacement, {
        executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
        projectionVersion,
        expectedProjectionVersion: TranscriptRepository.invalidatedProjectionVersion,
        expectedGeneration: invalidated.checkpointGeneration,
      }),
    ).toMatchObject({ _tag: "Committed" })
    expect(yield* repository.get(target.id)).toMatchObject({
      units: replacement.units,
      checkpointGeneration: 5,
      projectionVersion,
    })
  }),
)

it.effect("authoritatively adopts corrected terminal outcomes in paired memory repositories", () =>
  Effect.gen(function* () {
    for (const [index, status, type] of [
      [100, "failed", "execution.failed"],
      [101, "cancelled", "execution.cancelled"],
    ] as const) {
      const target = turn(index)
      const obsolete = Transcript.project(target.id, target.prompt, [event(0), event(1)])
      const turns = yield* TurnRepository.makeMemory([target])
      const repository = yield* TranscriptRepository.makeMemory({ turns })
      yield* commitAll(repository, target, obsolete, undefined, 2)
      const before = yield* repository.get(target.id)
      if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
      const replacement = Transcript.project(target.id, target.prompt, [
        {
          cursor: `${status}-cursor`,
          sequence: 0,
          type,
          createdAt: 10,
          ...(status === "failed" ? { text: "failed" } : {}),
        },
      ])
      const options = {
        executionCheckpoints: [executionCheckpoint(target, replacement, status)],
        projectionVersion,
        expectedProjectionVersion: 2,
        expectedGeneration: before.checkpointGeneration,
      }
      const committed = yield* repository.replaceForRefold(target, replacement, options)
      expect(committed).toMatchObject({ _tag: "Committed", turn: { status, lastCursor: `${status}-cursor` } })
      expect(yield* turns.get(target.id)).toMatchObject({ status, lastCursor: `${status}-cursor` })
      expect(yield* repository.get(target.id)).toMatchObject({
        turn: { status, lastCursor: `${status}-cursor` },
        units: replacement.units,
      })
      expect(
        yield* repository.replaceForRefold(target, replacement, {
          ...options,
          projectionVersion: projectionVersion + 1,
          expectedProjectionVersion: projectionVersion,
          expectedGeneration: before.checkpointGeneration + 1,
        }),
      ).toEqual({ _tag: "Stale" })
      expect(yield* turns.get(target.id)).toMatchObject({ status, lastCursor: `${status}-cursor` })
    }
  }),
)

it.effect("rejects a refold when the paired memory Turn tuple advanced concurrently", () =>
  Effect.gen(function* () {
    const target = turn(103)
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    const obsolete = Transcript.project(target.id, target.prompt, [event(0), event(1)])
    yield* commitAll(repository, target, obsolete, undefined, 2)
    const before = yield* repository.get(target.id)
    if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
    expect(yield* turns.repairCursor(target.id, "completed", undefined, "newer-cursor")).toBe(true)
    const newer = yield* turns.get(target.id)
    const preserved = yield* repository.get(target.id)
    const replacement = Transcript.project(target.id, target.prompt, [
      { cursor: "refold-failed", sequence: 0, type: "execution.failed", createdAt: 10, text: "failed" },
    ])

    expect(
      yield* repository.replaceForRefold(target, replacement, {
        executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
        projectionVersion,
        expectedProjectionVersion: 2,
        expectedGeneration: before.checkpointGeneration,
      }),
    ).toEqual({ _tag: "Stale" })
    expect(yield* turns.get(target.id)).toEqual(newer)
    expect(yield* repository.get(target.id)).toEqual(preserved)
  }),
)

it.effect("rejects contradictory checkpoint and projected terminal outcomes in paired memory repositories", () =>
  Effect.gen(function* () {
    const target = turn(102)
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    const obsolete = Transcript.project(target.id, target.prompt, [event(0), event(1)])
    yield* commitAll(repository, target, obsolete, undefined, 2)
    const before = yield* repository.get(target.id)
    if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
    const replacement = Transcript.project(target.id, target.prompt, [
      { cursor: "cancelled", sequence: 0, type: "execution.cancelled", createdAt: 10 },
    ])
    const rejected = yield* Effect.result(
      repository.replaceForRefold(target, replacement, {
        executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
        projectionVersion,
        expectedProjectionVersion: 2,
        expectedGeneration: before.checkpointGeneration,
      }),
    )
    expect(rejected._tag).toBe("Failure")
    if (rejected._tag === "Failure") expect(rejected.failure.message).toContain("contradictory terminal root outcomes")
    expect(yield* turns.get(target.id)).toEqual(target)
    expect(yield* repository.get(target.id)).toEqual(before)
  }),
)

it.layer(TranscriptRepository.memoryLayer)("transcript repository delta contract", (test) => {
  test.effect("restricts durable tuple identifiers to SQLite-stable ASCII text", () =>
    Effect.sync(() => {
      expect(() => Thread.ThreadId.make("thread-\ue000")).toThrow()
      expect(() => Thread.ThreadId.make("thread with space")).toThrow()
      expect(() => Turn.TurnId.make("turn-\u{10000}")).toThrow()
      expect(() => Turn.TurnId.make("turn\nline")).toThrow()
    }),
  )

  test.effect("rejects projection scalars outside the shared durable domain", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const cases: ReadonlyArray<{
        readonly name: string
        readonly version?: number
        readonly update: (state: Transcript.ProjectionState) => Transcript.ProjectionState
      }> = [
        { name: "projection-version", version: 0, update: (state) => state },
        { name: "revision", update: (state) => ({ ...state, revision: -2 }) },
        { name: "model-phase", update: (state) => ({ ...state, modelPhase: -2 }) },
        {
          name: "completion-sequence",
          update: (state) => ({ ...state, usableCompletionSequence: -1 }),
        },
        { name: "cost", update: (state) => ({ ...state, costUsd: -0.01 }) },
        {
          name: "unsafe-revision",
          update: (state) => ({ ...state, revision: Number.MAX_SAFE_INTEGER + 1 }),
        },
      ]

      for (const [index, candidate] of cases.entries()) {
        const target = turn(600 + index)
        const projection = Transcript.empty(target.id, target.prompt)
        const state = candidate.update(Transcript.projectionState(projection))
        const result = yield* Effect.result(
          repository.commitDelta(
            target,
            state,
            { upsert: projection.units, remove: [] },
            {
              executionCheckpoints: [executionCheckpoint(target, state)],
              projectionVersion: candidate.version ?? projectionVersion,
              expectedGeneration: undefined,
            },
          ),
        )
        expect(result._tag, candidate.name).toBe("Failure")
        expect(yield* repository.get(target.id)).toBeUndefined()
      }
    }),
  )

  test.effect("upserts and removes only named units while preserving every omitted unit", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(1)
      const initial = Transcript.project(target.id, target.prompt, [event(0), event(1)])
      expect(yield* commitAll(repository, target, initial, undefined)).toBe("committed")
      const stored = yield* repository.get(target.id)
      if (stored === undefined) return yield* Effect.die("initial projection was not stored")
      const assistant = stored.units.find(
        (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
      )
      if (assistant === undefined || assistant.content._tag !== "Entry")
        return yield* Effect.die("assistant unit was not stored")
      const updated = {
        ...assistant,
        revision: 2,
        content: { ...assistant.content, text: "updated once" },
      }
      expect(
        yield* repository.commitDelta(
          target,
          Transcript.projectionState({ ...initial, revision: 2 }),
          { upsert: [updated], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 2 })],
            projectionVersion,
            expectedGeneration: stored.checkpointGeneration,
          },
        ),
      ).toBe("committed")
      const afterUpdate = yield* repository.get(target.id)
      expect(afterUpdate?.units).toHaveLength(stored.units.length)
      expect(afterUpdate?.units.find((candidate) => candidate.key === updated.key)).toEqual(updated)
      expect(afterUpdate?.units.find((candidate) => candidate.key !== updated.key)).toEqual(
        stored.units.find((candidate) => candidate.key !== updated.key),
      )
      const moved = { ...updated, order: Transcript.unitOrder(updated.key, 50) }
      const movedResult = yield* Effect.result(
        repository.commitDelta(
          target,
          Transcript.projectionState({ ...initial, revision: 3 }),
          { upsert: [moved], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 3 })],
            projectionVersion,
            expectedGeneration: afterUpdate?.checkpointGeneration,
          },
        ),
      )
      expect(movedResult._tag).toBe("Failure")
      expect(yield* repository.get(target.id)).toEqual(afterUpdate)
      expect(
        yield* repository.commitDelta(
          target,
          Transcript.projectionState({ ...initial, revision: 3 }),
          { upsert: [], remove: [updated.key] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 3 })],
            projectionVersion,
            expectedGeneration: afterUpdate?.checkpointGeneration,
          },
        ),
      ).toBe("committed")
      expect((yield* repository.get(target.id))?.units.map((candidate) => candidate.key)).not.toContain(updated.key)
    }),
  )

  test.effect("uses an exact checkpoint compare-and-swap and changes nothing on conflict", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(2)
      const initial = { ...Transcript.project(target.id, target.prompt, [event(0)]), revision: 4 }
      yield* commitAll(repository, target, initial, undefined)
      const before = yield* repository.get(target.id)
      const replacement = Transcript.project(target.id, target.prompt, [event(0), event(1)])
      const result = yield* repository.commitDelta(
        target,
        Transcript.projectionState({ ...replacement, revision: 6 }),
        { upsert: replacement.units, remove: [] },
        {
          executionCheckpoints: [executionCheckpoint(target, { ...replacement, revision: 6 })],
          projectionVersion,
          expectedGeneration: 3,
        },
      )
      expect(result).toBe("stale")
      expect(yield* repository.get(target.id)).toEqual(before)
      expect(
        yield* repository.commitDelta(
          target,
          Transcript.projectionState({ ...replacement, revision: 3 }),
          { upsert: replacement.units, remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...replacement, revision: 3 })],
            projectionVersion,
            expectedGeneration: 0,
          },
        ),
      ).toBe("stale")
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )

  test.effect("atomically couples an attached child to its parent unit", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(150)
      const nested = nestedProjection(target, "child:turn-150:parent")

      expect(
        yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
      ).toBe("committed")
      const before = yield* repository.get(target.id)
      expect(before?.executionCheckpoints).toHaveLength(2)

      const removal = yield* Effect.result(
        repository.commitDelta(
          target,
          Transcript.projectionState(nested.projection),
          { upsert: [], remove: [nested.parent.key] },
          {
            executionCheckpoints: nested.checkpoints,
            projectionVersion,
            expectedGeneration: before?.checkpointGeneration,
          },
        ),
      )

      expect(removal._tag).toBe("Failure")
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )

  test.effect("requires a complete root-connected checkpoint graph for refold", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(151)
      const obsolete = Transcript.empty(target.id, target.prompt)
      expect(yield* commitAll(repository, target, obsolete, undefined, 2)).toBe("committed")
      const before = yield* repository.get(target.id)
      if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
      const nested = nestedProjection(target, "child:turn-151:parent")

      for (const candidate of invalidCheckpointGraphs(target, nested, "child:turn-151:peer")) {
        const result = yield* Effect.result(
          repository.replaceForRefold(target, nested.projection, {
            executionCheckpoints: candidate.checkpoints,
            projectionVersion,
            expectedProjectionVersion: 2,
            expectedGeneration: before.checkpointGeneration,
          }),
        )
        expect(result._tag, candidate.name).toBe("Failure")
        if (result._tag === "Failure")
          expect(result.failure, candidate.name).toBeInstanceOf(TranscriptRepository.RepositoryError)
        expect(yield* repository.get(target.id), candidate.name).toEqual(before)
      }

      expect(
        yield* repository.replaceForRefold(target, nested.projection, {
          executionCheckpoints: nested.checkpoints,
          projectionVersion,
          expectedProjectionVersion: 2,
          expectedGeneration: before.checkpointGeneration,
        }),
      ).toMatchObject({ _tag: "Committed" })
      const stored = yield* repository.get(target.id)
      expect(stored?.units).toEqual(nested.projection.units)
      expect(stored?.executionCheckpoints).toEqual(nested.checkpoints.toSorted(compareExecutionCheckpoints))
      expect(stored?.projectionVersion).toBe(projectionVersion)
    }),
  )

  test.effect("rejects checkpoint cursors that contradict exact fold state", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(200)
      const projection = Transcript.project(target.id, target.prompt, [event(0)])
      yield* commitAll(repository, target, projection, undefined)
      const before = yield* repository.get(target.id)
      const key = Transcript.executionKey(String(target.id))
      const result = yield* Effect.result(
        repository.commitDelta(
          target,
          Transcript.projectionState(projection),
          { upsert: [], remove: [] },
          {
            executionCheckpoints: [
              { ...executionCheckpoint(target, projection), executionKey: key, cursor: "contradictory" },
            ],
            projectionVersion,
            expectedGeneration: before?.checkpointGeneration,
          },
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )

  test.effect("advances checkpoint authority without inventing a source-event revision", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(300)
      const projection = Transcript.project(target.id, target.prompt, [event(0)])
      yield* commitAll(repository, target, projection, undefined)
      const initial = yield* repository.get(target.id)
      if (initial === undefined) return yield* Effect.die("initial projection was not stored")
      const assistant = initial.units.find(
        (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
      )
      if (assistant === undefined || assistant.content._tag !== "Entry")
        return yield* Effect.die("assistant unit was not stored")
      const updated = { ...assistant, content: { ...assistant.content, text: "same-event update" } }
      expect(
        yield* repository.commitDelta(
          target,
          Transcript.projectionState(projection),
          { upsert: [updated], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, projection)],
            projectionVersion,
            expectedGeneration: initial.checkpointGeneration,
          },
        ),
      ).toBe("committed")
      const committed = yield* repository.get(target.id)
      expect(committed?.revision).toBe(projection.revision)
      expect(committed?.checkpointGeneration).toBe(initial.checkpointGeneration + 1)
      expect(
        yield* repository.commitDelta(
          target,
          Transcript.projectionState(projection),
          { upsert: [], remove: [updated.key] },
          {
            executionCheckpoints: [executionCheckpoint(target, projection)],
            projectionVersion,
            expectedGeneration: initial.checkpointGeneration,
          },
        ),
      ).toBe("stale")
      expect(yield* repository.get(target.id)).toEqual(committed)
    }),
  )

  test.effect("fails duplicate and non-intrinsic identities without changing the checkpoint", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(3)
      const initial = { ...Transcript.empty(target.id, target.prompt), revision: 0 }
      yield* commitAll(repository, target, initial, undefined)
      const before = yield* repository.get(target.id)
      const duplicate = unit(target.id, 1, 0, "duplicate")
      const duplicateFailure = yield* Effect.result(
        repository.commitDelta(
          target,
          Transcript.projectionState({ ...initial, revision: 1 }),
          { upsert: [duplicate, { ...duplicate, revision: 2 }], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 1 })],
            projectionVersion,
            expectedGeneration: 0,
          },
        ),
      )
      const invalid = { ...unit(target.id, 2, 0, "invalid"), order: Transcript.unitOrder("other", 2) }
      const intrinsicFailure = yield* Effect.result(
        repository.commitDelta(
          target,
          Transcript.projectionState({ ...initial, revision: 1 }),
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
      const obsolete = { ...Transcript.project(target.id, target.prompt, [event(0), event(1)]), revision: 50 }
      yield* commitAll(repository, target, obsolete, undefined, 2)
      const replacement = Transcript.project(target.id, target.prompt, [event(2)])
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
        yield* commitAll(repository, target, Transcript.empty(target.id, target.prompt), undefined, version)

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
          { ...Transcript.empty(target.id, target.prompt), units, revision: 2 },
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
      const parent = Transcript.project(target.id, target.prompt, [
        {
          cursor: "tool",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: { tool_call_id: "agent", tool_name: "task", input: {} },
        },
      ])
      const child = Transcript.project(childId, "", [event(0), event(1)])
      const nested = {
        ...Transcript.withNestedProjections(parent, [{ parentId: `${target.id}:agent`, projection: child }]),
        revision: 4,
        costUsd: 1.25,
        pricingVersion: Transcript.pricingVersion,
        usableCompletionSequence: 3,
      }
      const parentTool = parent.units.find(
        (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
      )
      if (parentTool === undefined) return yield* Effect.die("nested transcript had no parent tool")
      yield* commitAll(repository, target, nested, undefined, projectionVersion, [
        executionCheckpoint(target, nested),
        attachedExecutionCheckpoint(childId, child, Transcript.executionKey(String(target.id)), parentTool),
      ])
      const other = turn(21, threadId)
      yield* commitAll(
        repository,
        other,
        { ...Transcript.empty(other.id, other.prompt), revision: 0, costUsd: 2.5 },
        undefined,
      )
      const stored = yield* repository.get(target.id)
      const page = yield* repository.page(threadId, { limit: 1 })
      expect(stored?.units).toEqual(nested.units)
      expect(stored?.pricingVersion).toBe(Transcript.pricingVersion)
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
        { ...Transcript.empty(target.id, target.prompt), units, revision: 200 },
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
