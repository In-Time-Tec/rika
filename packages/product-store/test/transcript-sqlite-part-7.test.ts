import {
  expect,
  it,
  BunServices,
  TranscriptCorrelation,
  TranscriptOrdering,
  TranscriptProjection,
  Effect,
  FileSystem,
  SqlClient,
  Thread,
  TranscriptRepository,
  Turn,
  createTurn,
  attachedExecutionCheckpoint,
  commitAll,
  executionCheckpoint,
  projectionVersion,
  provideLayer,
  sqliteLayer,
  unit,
} from "./transcript-sqlite-part-support"

it.effect("orders Unicode and nested order segments exactly like SQLite BINARY", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-collation-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-collation")
      const turnId = Turn.TurnId.make("turn-collation")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const target = yield* createTurn(threadId, turnId, "collation")
          const flat = ["a", "aa", "\ud7ff", "\u{10000}", "\ue000"].map((key) => unit(turnId, 1, 0, key))
          const parentProjection = TranscriptProjection.Projection.project(turnId, target.prompt, [
            {
              cursor: "parent",
              sequence: 0,
              type: "tool.call.requested",
              createdAt: 0,
              data: { tool_call_id: "parent", tool_name: "task", input: {} },
            },
          ])
          const parent = parentProjection.units.find(
            (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
          )
          if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
            return yield* Effect.die("collation transcript had no parent tool")
          const parentId = parent.content.block.id
          const nested = ["child-\ud7ff", "child-\u{10000}", "child-\ue000"].map((executionId, index) => {
            const local = unit(turnId, 1, 0, `nested-${index}`)
            return Object.assign({}, local, {
              turnId: executionId,
              parentId,
              order: TranscriptOrdering.childOrder(parent.order, executionId, local.order),
            })
          })
          const units = [parent, ...flat, ...nested]
          const projection = { ...TranscriptProjection.Projection.empty(turnId, target.prompt), units, revision: 1 }
          yield* commitAll(repository, target, projection, undefined, projectionVersion, [
            executionCheckpoint(target, projection),
            ...nested.map((candidate) =>
              attachedExecutionCheckpoint(
                candidate.turnId,
                { revision: candidate.revision, modelPhase: -1 },
                TranscriptCorrelation.executionKey(String(turnId)),
                parent,
              ),
            ),
          ])
          const expected = units
            .toSorted((left, right) => TranscriptOrdering.compareUnitOrder(left.order, right.order))
            .map((candidate) => candidate.key)
          const durable = yield* sql`SELECT unit_key FROM rika_transcript_units
            WHERE turn_id = ${turnId} ORDER BY unit_order_key COLLATE BINARY`
          expect(durable.map((row) => row.unit_key)).toEqual(expected)
          expect((yield* repository.get(turnId))?.units.map((candidate) => candidate.key)).toEqual(expected)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
