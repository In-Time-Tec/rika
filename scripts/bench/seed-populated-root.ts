import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@rika/persistence/database"
import * as Thread from "@rika/persistence/thread"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Turn from "@rika/persistence/turn"
import * as TurnRepository from "@rika/persistence/turn-repository"
import { Effect, Layer } from "effect"

const threadCount = Number(process.env.RIKA_SEED_THREAD_COUNT ?? "100")
const turnsPerThread = Number(process.env.RIKA_SEED_TURNS_PER_THREAD ?? "1")
const root = process.env.RIKA_SEED_ROOT
if (root === undefined || root.length === 0) {
  console.error("RIKA_SEED_ROOT is required")
  process.exit(1)
}

const filename = `${root}/rika.db`

const sqliteLayer = (() => {
  const database = Database.layer(filename)
  return Layer.mergeAll(
    database,
    ThreadRepository.layer.pipe(Layer.provide(database)),
    TurnRepository.layer.pipe(Layer.provide(database)),
  ).pipe(Layer.provide(BunServices.layer))
})()

const seed = Effect.gen(function* () {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  for (let index = 0; index < threadCount; index += 1) {
    const threadId = Thread.ThreadId.make(`idle-thread-${index}`)
    yield* threads.create({
      id: threadId,
      workspace: `/bench/ws-${index % 10}`,
      title: `Idle thread ${index}`,
      now: index + 1,
    })
    for (let turnIndex = 0; turnIndex < turnsPerThread; turnIndex += 1) {
      const turnId = Turn.TurnId.make(`idle-turn-${index}-${turnIndex}`)
      yield* turns.createForSubmission({
        id: turnId,
        threadId,
        prompt: `prompt ${index}-${turnIndex}`,
        executionRoute: Turn.testExecutionRoute(),
        queueCapacity: 128,
        now: index + 1,
      })
      yield* turns.setStatus(turnId, "completed", undefined, index + 2)
    }
  }
  const listed = yield* threads.listAll
  return { threadCount: listed.length, turnsPerThread }
})

await Effect.runPromise(
  seed.pipe(
    Effect.provide(sqliteLayer),
    Effect.tap(({ threadCount: created, turnsPerThread: perThread }) =>
      Effect.sync(() =>
        console.log(
          JSON.stringify({
            root: process.env.RIKA_SEED_ROOT,
            database: filename,
            threadCount: created,
            turnsPerThread: perThread,
          }),
        ),
      ),
    ),
  ),
)
