import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@rika/product-store/product-database-layer"
import * as GoalRepository from "@rika/product-store/sqlite-goal-repository"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Cause, Crypto, Duration, Effect, FileSystem, Layer } from "effect"
import { provideLayerScoped } from "./server-configuration-adapter"

const dirname = process.getBuiltinModule("node:path").dirname
const mkdir = (path: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, { recursive: true })))

export const recoveredWorkGrace = (value: string) => Duration.millis(Number(value))

/**
 * The profile data root the kernel pins, derived from the one runtime database path the
 * composition root already supplies rather than threaded separately.
 */
export const dataRootOf = (batonDatabase: string): string => {
  const separator = batonDatabase.lastIndexOf("/")
  return separator > 0 ? batonDatabase.slice(0, separator) : "."
}

export const makeThreadId: Effect.Effect<Thread.ThreadId, never, never> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map(Thread.ThreadId.make),
  Effect.orDie,
  provideLayerScoped(BunServices.layer),
)

export const makeTurnId: Effect.Effect<Turn.TurnId, never, never> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map(Turn.TurnId.make),
  Effect.orDie,
  provideLayerScoped(BunServices.layer),
)

export const makeServerRepositoryLayers = (database: string) => {
  const productDatabase = Layer.unwrap(
    Effect.gen(function* () {
      yield* mkdir(dirname(database))
      return Database.layer(database)
    }),
  )
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabase), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadSummaryRepositoryLayer = ThreadSummaryRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const goalRepositoryLayer = GoalRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadSearchRepositoryLayer = ThreadSearchRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
    Layer.catchCause((cause) =>
      Layer.effectContext(Effect.fail(ThreadSearchRepository.RepositoryError.make({ message: Cause.pretty(cause) }))),
    ),
  )
  return {
    productDatabase,
    repositoryLayer,
    turnRepositoryLayer,
    threadSummaryRepositoryLayer,
    transcriptRepositoryLayer,
    threadSearchRepositoryLayer,
    goalRepositoryLayer,
  }
}
