import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptRecordedShell from "@rika/transcript/recorded-shell-presentation"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import { projectionVersion, provideLayer, sqliteLayer } from "./transcript-repository-fixtures"

const threadId = Thread.ThreadId.make("recorded-shell-thread")
const running = (id: string): Turn.RunningRecordedShellTurn => ({
  _tag: "RecordedShell",
  id: Turn.TurnId.make(id),
  threadId,
  prompt: "$ printf shell",
  command: "printf shell",
  status: "running",
  stopIntent: "none",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 10,
  updatedAt: 10,
})

const terminal = (turn: Turn.RunningRecordedShellTurn): Turn.TerminalRecordedShellTurn => ({
  ...turn,
  status: "completed",
  result: { text: "shell", truncated: false, exitCode: 0 },
  updatedAt: 20,
})

const exercise = Effect.fn("RecordedShellRepositoryTest.exercise")(function* (
  turns: TurnRepository.Interface,
  transcripts: TranscriptRepository.Interface,
) {
  const invalid = running("recorded-shell-invalid")
  expect((yield* Effect.result(transcripts.createRecordedShell(invalid, 0)))._tag).toBe("Failure")
  expect(yield* turns.get(invalid.id)).toBeUndefined()
  expect(yield* transcripts.get(invalid.id)).toBeUndefined()

  const initialTurn = running("recorded-shell-turn")
  const initial = yield* transcripts.createRecordedShell(initialTurn, projectionVersion)
  const expectedRunning = TranscriptRecordedShell.recordedShellProjection({
    id: initialTurn.id,
    command: initialTurn.command,
    status: "running",
  })
  expect(initial).toMatchObject({
    turn: initialTurn,
    units: expectedRunning.units,
    checkpointGeneration: 0,
    revision: 0,
    modelPhase: -1,
    executionCheckpoints: [],
    projectionVersion,
  })
  expect(yield* turns.get(initialTurn.id)).toEqual(initialTurn)
  expect(yield* turns.findActive(threadId)).toBeUndefined()
  expect(yield* turns.listNonterminal).toEqual([])
  expect(yield* turns.listStopRequested).toEqual([])
  expect(yield* turns.requestStop(initialTurn.id, 11)).toBeUndefined()
  expect(yield* turns.claimNextQueued(threadId, 11)).toBeUndefined()
  expect((yield* turns.readQueue(threadId)).turns).toEqual([])

  const completedTurn = terminal(initialTurn)
  const beforeStale = {
    turn: yield* turns.get(initialTurn.id),
    projection: yield* transcripts.get(initialTurn.id),
  }
  expect(
    yield* transcripts.settleRecordedShell(
      { ...initialTurn, updatedAt: initialTurn.updatedAt + 1 },
      completedTurn,
      0,
      projectionVersion,
    ),
  ).toEqual({ _tag: "Stale" })
  expect({
    turn: yield* turns.get(initialTurn.id),
    projection: yield* transcripts.get(initialTurn.id),
  }).toEqual(beforeStale)
  expect(yield* transcripts.settleRecordedShell(initialTurn, completedTurn, 99, projectionVersion)).toEqual({
    _tag: "Stale",
  })
  expect({
    turn: yield* turns.get(initialTurn.id),
    projection: yield* transcripts.get(initialTurn.id),
  }).toEqual(beforeStale)

  const settled = yield* transcripts.settleRecordedShell(initialTurn, completedTurn, 0, projectionVersion)
  expect(settled._tag).toBe("Committed")
  if (settled._tag !== "Committed") return yield* Effect.die("recorded shell settlement was stale")
  const expectedTerminal = TranscriptRecordedShell.settleRecordedShellProjection(expectedRunning, completedTurn)
  expect(settled.projection).toMatchObject({
    turn: completedTurn,
    units: expectedTerminal.units,
    checkpointGeneration: 1,
    revision: 1,
    modelPhase: -1,
    executionCheckpoints: [],
    projectionVersion,
  })
  expect(settled.projection.units[0]?.key).toBe(initial.units[0]?.key)
  expect(settled.projection.units[0]?.order).toEqual(initial.units[0]?.order)
  expect(yield* turns.get(initialTurn.id)).toEqual(completedTurn)

  const beforeDuplicate = {
    turn: yield* turns.get(initialTurn.id),
    projection: yield* transcripts.get(initialTurn.id),
  }
  expect((yield* Effect.result(transcripts.createRecordedShell(initialTurn, projectionVersion)))._tag).toBe("Failure")
  expect({
    turn: yield* turns.get(initialTurn.id),
    projection: yield* transcripts.get(initialTurn.id),
  }).toEqual(beforeDuplicate)

  const page = yield* transcripts.page(threadId, { projectionVersion })
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]).toMatchObject({
    turn: completedTurn,
    unit: expectedTerminal.units[0],
    projectionRevision: 1,
    projectionModelPhase: -1,
  })
  expect(page.threadCostUsd).toBe(0)

  const copiedTurn: Turn.TerminalRecordedShellTurn = {
    ...completedTurn,
    id: Turn.TurnId.make("recorded-shell-copy"),
  }
  const copied = yield* transcripts.copyRecordedShell(copiedTurn, projectionVersion)
  const expectedCopy = TranscriptRecordedShell.settleRecordedShellProjection(
    TranscriptRecordedShell.recordedShellProjection({
      id: copiedTurn.id,
      command: copiedTurn.command,
      status: "running",
    }),
    copiedTurn,
  )
  expect(copied).toMatchObject({
    turn: copiedTurn,
    units: expectedCopy.units,
    checkpointGeneration: 0,
    revision: 1,
    modelPhase: -1,
    executionCheckpoints: [],
    projectionVersion,
  })
  expect(yield* turns.get(copiedTurn.id)).toEqual(copiedTurn)
  const beforeDuplicateCopy = {
    turn: yield* turns.get(copiedTurn.id),
    projection: yield* transcripts.get(copiedTurn.id),
  }
  expect((yield* Effect.result(transcripts.copyRecordedShell(copiedTurn, projectionVersion)))._tag).toBe("Failure")
  expect({
    turn: yield* turns.get(copiedTurn.id),
    projection: yield* transcripts.get(copiedTurn.id),
  }).toEqual(beforeDuplicateCopy)
})

it.effect("atomically records and settles shell turns in paired memory repositories", () =>
  Effect.gen(function* () {
    const turns = yield* TurnRepository.makeMemory()
    const transcripts = yield* TranscriptRepository.makeMemory({ turns })
    yield* exercise(turns, transcripts)
  }),
)

it.effect("atomically records and settles shell turns in SQLite without execution provenance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-recorded-shell-" })
      const filename = `${directory}/rika.db`
      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          yield* threads.create({ id: threadId, workspace: "/work", title: "Shell", now: 1 })
          yield* exercise(turns, transcripts)
          expect(
            yield* sql`SELECT execution_key FROM rika_transcript_units WHERE turn_id = ${Turn.TurnId.make("recorded-shell-turn")}`,
          ).toEqual([{ execution_key: null }])
          expect(
            yield* sql`SELECT execution_key FROM rika_transcript_execution_checkpoints WHERE turn_id = ${Turn.TurnId.make("recorded-shell-turn")}`,
          ).toEqual([])
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
