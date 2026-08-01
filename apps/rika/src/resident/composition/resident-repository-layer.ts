import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadResult from "@rika/product/thread-result"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Cause, Crypto, Duration, Effect, Layer, Schema, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { execution as residentExecution } from "./resident-execution-layer"
const { executionModelRoutes } = residentExecution

const dirname = process.getBuiltinModule("node:path").dirname
const mkdir = (path: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, { recursive: true })))

export const recoveredWorkGrace = (value: string) => Duration.millis(Number(value))

export const makeThreadId: Effect.Effect<Thread.ThreadId, never, never> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map(Thread.ThreadId.make),
  Effect.orDie,
  Effect.provide(BunServices.layer),
)

export const makeTurnId: Effect.Effect<Turn.TurnId, never, never> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map(Turn.TurnId.make),
  Effect.orDie,
  Effect.provide(BunServices.layer),
)

export const makeResidentRepositoryLayers = (database: string, executionDatabase: string) => {
  const productDatabase = Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.all([mkdir(dirname(database)), mkdir(dirname(executionDatabase))], { concurrency: 2 })
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
  const usageRepositoryLayer = UsageRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadInteractionRepositoryLayer = ThreadInteractionRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
    Layer.catchCause((cause) =>
      Layer.effectContext(
        Effect.fail(ThreadInteractionRepository.RepositoryError.make({ message: Cause.pretty(cause) })),
      ),
    ),
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
    usageRepositoryLayer,
    threadInteractionRepositoryLayer,
    threadSearchRepositoryLayer,
  }
}

export const persistedModelRoutesForStartup = (turns: ReadonlyArray<Turn.Turn>) =>
  turns.filter(ThreadResult.TurnResult.isAgentExecution).flatMap((turn) => executionModelRoutes(turn.executionRoute))

const persistedExecutionRouteRow = Schema.Struct({ execution_route_json: Schema.String })
const persistedExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot.ExecutionRouteSnapshot)

export const allPersistedModelRoutesForStartup = (
  persistedTitleRoutes: ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot>,
) =>
  TurnRepository.Service.pipe(
    Effect.flatMap((turns) => turns.listNonterminal),
    Effect.map((turns) => [...persistedModelRoutesForStartup(turns), ...persistedTitleRoutes]),
  )

export const persistedTitleModelRoutesForStartup = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql`SELECT execution_route_json FROM rika_turns WHERE turn_kind = 'AgentExecution'`
  const routes = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(persistedExecutionRouteRow)(row).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeUnknownEffect(persistedExecutionRouteJson)(decoded.execution_route_json),
      ),
    ),
  )
  return routes.flatMap((route) => (route.title === undefined ? [] : [route.title]))
}).pipe(Effect.withSpan("ResidentRepository.persistedTitleModelRoutesForStartup"))
