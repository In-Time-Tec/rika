import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@rika/store/product-database-layer"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/store/sqlite-thread-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TurnRepository from "@rika/store/sqlite-turn-repository"
import { Config, Effect, FileSystem, Layer, Path, Schema, pipe } from "effect"
import type { ConfigError as EffectConfigError } from "effect/Config"
import type * as PlatformError from "effect/PlatformError"

class SeedConfigurationError extends Schema.TaggedErrorClass<SeedConfigurationError>()("SeedConfigurationError", {
  message: Schema.String,
}) {}

const SeedOutput = Schema.Struct({
  root: Schema.String,
  database: Schema.String,
  threadCount: Schema.Int,
  turnsPerThread: Schema.Int,
})

const SeedOutputJson = Schema.fromJsonString(SeedOutput)

type SeedConfiguration = {
  readonly threadCount: number
  readonly turnsPerThread: number
  readonly root: string
}

const sqliteLayer = (
  filename: string,
): Layer.Layer<ThreadRepository.Service | TurnRepository.Service, never, FileSystem.FileSystem | Path.Path> => {
  const database = Database.layer(filename)
  return pipe(Layer.mergeAll(ThreadRepository.layer, TurnRepository.layer), Layer.provide(database), Layer.orDie)
}

const configuration: Config.Config<SeedConfiguration> = Config.all({
  threadCount: Config.int("RIKA_SEED_THREAD_COUNT").pipe(Config.withDefault(100)),
  turnsPerThread: Config.int("RIKA_SEED_TURNS_PER_THREAD").pipe(Config.withDefault(1)),
  root: Config.string("RIKA_SEED_ROOT"),
})

const seed = Effect.gen(function* () {
  const { threadCount, turnsPerThread, root } = yield* configuration
  if (root.length === 0) return yield* SeedConfigurationError.make({ message: "RIKA_SEED_ROOT is required" })
  const filename = `${root}/rika.db`
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
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
        queueCapacity: 128,
        now: index + 1,
      })
      yield* turns.setStatus(turnId, "completed", undefined, index + 2)
    }
  }
  const listed = yield* threads.listAll
  return yield* Schema.encodeEffect(SeedOutputJson)({
    root,
    database: filename,
    threadCount: listed.length,
    turnsPerThread,
  })
}).pipe(Effect.orDie)

const configuredDatabase: Layer.Layer<
  ThreadRepository.Service | TurnRepository.Service,
  EffectConfigError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> = Layer.unwrap(configuration.pipe(Effect.map(({ root }) => sqliteLayer(`${root}/rika.db`))))

const services = pipe(configuredDatabase, Layer.provideMerge(BunServices.layer), Layer.orDie)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(services), (context) =>
        Effect.provide(
          seed.pipe(
            Effect.tap((output) => Effect.log(output)),
            Effect.orDie,
          ),
          context,
        ),
      ),
    ),
  )
