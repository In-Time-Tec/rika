import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "../../packages/persistence/src/product-database"
import * as ThreadRepository from "../../packages/persistence/src/thread-repository"
import * as Thread from "../../packages/persistence/src/thread-schema"
import * as TurnRepository from "../../packages/persistence/src/turn-repository"
import * as Turn from "../../packages/persistence/src/turn-schema"
import { Config, Effect, Layer, Schema } from "effect"

const repositoryLayer = (filename: string) => {
  const database = Database.layer(filename)
  return Layer.mergeAll(
    ThreadRepository.layer.pipe(Layer.provide(database)),
    TurnRepository.layer.pipe(Layer.provide(database)),
  ).pipe(Layer.provide(BunServices.layer))
}

const seed = Effect.gen(function* () {
  const threadCount = yield* Config.int("RIKA_SEED_THREAD_COUNT").pipe(Config.withDefault(100))
  const turnsPerThread = yield* Config.int("RIKA_SEED_TURNS_PER_THREAD").pipe(Config.withDefault(1))
  const root = yield* Config.nonEmptyString("RIKA_SEED_ROOT")
  const filename = `${root}/rika.db`
  const context = yield* Layer.build(repositoryLayer(filename))
  const result = yield* Effect.gen(function* () {
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
  }).pipe(Effect.provide(context))
  const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
    root,
    database: filename,
    threadCount: result.threadCount,
    turnsPerThread: result.turnsPerThread,
  })
  yield* Effect.logInfo(encoded)
})

if (import.meta.main) BunRuntime.runMain(Effect.scoped(seed))
