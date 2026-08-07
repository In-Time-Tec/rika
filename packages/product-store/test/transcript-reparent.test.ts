import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "@rika/product-store/product-database-layer"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { id, create, provideLayer } from "./sqlite-queue-support"

const state = {
  status: "running" as const,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
}

const childUnit = (turnId: Turn.TurnId, revision: number, parentId?: string) => ({
  key: "child:unit",
  turnId,
  order: unitOrder("child:unit", 0),
  revision,
  content: { _tag: "Entry" as const, role: "assistant" as const, text: "child report" },
  ...(parentId === undefined ? {} : { parentId }),
})

test("a late parent link is written through instead of being silently skipped", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-reparent-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        yield* threads.create({ id, workspace: "/work", title: "Reparent", now: 1 })
        const turn = yield* create(turns, {
          id: Turn.TurnId.make("reparent-turn"),
          threadId: id,
          prompt: "delegate",
          now: 2,
        })

        // The child streams before its subagent card is linked, so it lands with no parent.
        yield* transcripts.commitProjection(turn, {
          _tag: "ProjectionSnapshot",
          revision: 0,
          checkpoint: { version: 1, cursor: "c0", state: "{}" },
          units: [childUnit(turn.id, 0)],
          hasOlder: false,
          state,
        })
        expect((yield* transcripts.get(turn.id))?.units[0]?.parentId).toBeUndefined()

        // A late ChildLinked re-emits the same key with its resolved parent. This is an
        // ON CONFLICT upsert, and the durable row must adopt the corrected parent.
        yield* transcripts.commitProjection(turn, {
          _tag: "ProjectionPatch",
          baseRevision: 0,
          revision: 1,
          checkpoint: { version: 1, cursor: "c1", state: "{}" },
          upsert: [childUnit(turn.id, 1, "subagent-block-1")],
          remove: [],
          state,
        })
        expect((yield* transcripts.get(turn.id))?.units[0]?.parentId).toBe("subagent-block-1")
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
