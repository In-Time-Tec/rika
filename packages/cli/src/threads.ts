import { existsSync } from "node:fs"
import { ThreadService, TournamentService } from "@rika/agent"
import { Embeddings } from "@rika/llm"
import { Database, OrbStore, ThreadImport, ThreadMemoryStore, ThreadProjection } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Args from "./args"
import * as Input from "./input"
import * as Output from "./output"
import * as Tournament from "./tournament"

export class ThreadsError extends Schema.TaggedErrorClass<ThreadsError>()("ThreadsError", {
  message: Schema.String,
  action: Args.ThreadAction,
}) {}

export type RunError =
  | Database.DatabaseError
  | ThreadService.Error
  | TournamentService.RunError
  | OrbStore.OrbStoreError
  | ThreadMemoryStore.ThreadMemoryStoreError
  | ThreadProjection.ThreadProjectionError
  | Embeddings.EmbeddingsProviderError
  | Embeddings.EmbeddingsValidationError
  | Client.SdkError
  | Input.InputError
  | ThreadsError

export interface Interface {
  readonly executeCommand: (command: Args.ThreadCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Threads") {}

export class RemoteClient extends Context.Service<RemoteClient, Client.Interface>()("@rika/cli/Threads/RemoteClient") {}

export const remoteClientLayer = (client: Client.Interface) => Layer.succeed(RemoteClient, RemoteClient.of(client))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const input = yield* Input.Service
    const database = yield* Database.Service
    const threads = yield* ThreadService.Service
    const projection = yield* ThreadProjection.Service
    const tournament = yield* Effect.serviceOption(TournamentService.Service)
    const orbs = yield* OrbStore.Service
    const remoteClient = yield* Effect.serviceOption(RemoteClient)
    const embeddings = Option.getOrUndefined(yield* Effect.serviceOption(Embeddings.Service))
    const memoryStore = Option.getOrUndefined(yield* Effect.serviceOption(ThreadMemoryStore.Service))

    return Service.of({
      executeCommand: Effect.fn("Cli.Threads.executeCommand")(function* (command: Args.ThreadCommand) {
        switch (command.action) {
          case "list": {
            const summaries = yield* threads.list(listInput(command))
            const enriched = yield* Effect.forEach(summaries, (summary) => withOrbStatus(orbs, summary))
            yield* output.stdout(formatJson(enriched))
            return 0
          }
          case "search": {
            if (command.semantic === true) {
              const semantic = yield* semanticSearch({
                command,
                output,
                threads,
                ...(embeddings === undefined ? {} : { embeddings }),
                ...(memoryStore === undefined ? {} : { memoryStore }),
              })
              if (semantic !== undefined) {
                yield* output.stdout(formatJson(semantic))
                return 0
              }
            }
            const results = yield* threads.search(searchInput(command))
            yield* output.stdout(formatJson(results))
            return 0
          }
          case "archive": {
            const summary = yield* threads.archive({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "unarchive": {
            const summary = yield* threads.unarchive({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "visibility": {
            const visibility = yield* requireVisibility(command)
            const summary = yield* threads.setVisibility({
              thread_id: yield* requireThreadId(command),
              visibility,
            })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "compact": {
            const remote = Option.getOrUndefined(remoteClient)
            if (remote === undefined) {
              return yield* new ThreadsError({
                message: "Thread compaction requires the shared backend client",
                action: command.action,
              })
            }
            const event = yield* remote.compactThread(yield* requireThreadId(command))
            yield* output.stdout(formatJson(event))
            return 0
          }
          case "fork": {
            const summary = yield* threads.fork({
              thread_id: yield* requireThreadId(command),
              ...(command.at_turn === undefined ? {} : { at_turn: command.at_turn }),
            })
            yield* output.stdout(formatJson(summary.thread_id))
            return 0
          }
          case "tournament": {
            const tournamentRunner = Option.getOrUndefined(tournament)
            if (tournamentRunner === undefined) {
              return yield* new ThreadsError({
                message: "Thread tournament requires the local tournament runner",
                action: command.action,
              })
            }
            const message = yield* tournamentMessage(input, command)
            const result = yield* tournamentRunner.run({
              thread_id: yield* requireThreadId(command),
              message,
              branch_count: command.branch_count ?? 3,
              ...(command.modes === undefined ? {} : { modes: command.modes }),
              ...(command.rubric === undefined ? {} : { rubric: command.rubric }),
            })
            yield* output.stdout(Tournament.formatResult(result))
            return 0
          }
          case "share": {
            const exported = yield* threads.share({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(exported))
            return 0
          }
          case "reference": {
            const reference = yield* threads.reference({
              thread_id: yield* requireThreadId(command),
              ...(command.query === undefined ? {} : { query: command.query }),
            })
            yield* output.stdout(formatJson(reference))
            return 0
          }
          case "delete": {
            yield* threads.deleteThread({ thread_id: yield* requireThreadId(command) })
            return 0
          }
          case "rebuild-projection": {
            yield* projection.rebuild().pipe(Effect.provideService(Database.Service, database))
            yield* output.stdout(formatJson({ rebuilt: true }))
            return 0
          }
          case "import": {
            const sourceDataDir = yield* requireSourceDataDir(command)
            const sourcePath = `${sourceDataDir}/rika.sqlite`
            if (!existsSync(sourcePath)) {
              return yield* new ThreadsError({
                message: `Source database not found: ${sourcePath}`,
                action: command.action,
              })
            }
            const imported = yield* database.withDatabase((db) => ThreadImport.importFromSqlite(db, sourcePath))
            yield* projection.rebuild().pipe(Effect.provideService(Database.Service, database))
            yield* output.stdout(formatJson({ ...imported, rebuilt: true }))
            return 0
          }
        }
        return yield* new ThreadsError({
          message: "Unsupported thread action",
          action: command.action,
        })
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Threads.executeCommand.call")(function* (command: Args.ThreadCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ThreadsError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireThreadId = (command: Args.ThreadCommand) =>
  command.thread_id === undefined
    ? Effect.fail(new ThreadsError({ message: `Thread id is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.thread_id)

const requireSourceDataDir = (command: Args.ThreadCommand) =>
  command.source_data_dir === undefined
    ? Effect.fail(
        new ThreadsError({ message: "Source data directory is required for import", action: command.action }),
      )
    : Effect.succeed(command.source_data_dir)

const requireVisibility = (command: Args.ThreadCommand) =>
  command.visibility === undefined
    ? Effect.fail(new ThreadsError({ message: "Thread visibility is required", action: command.action }))
    : Effect.succeed(command.visibility)

const listInput = (command: Args.ThreadCommand): ThreadService.ListInput => ({
  ...(command.include_archived === undefined ? {} : { include_archived: command.include_archived }),
  ...(command.limit === undefined ? {} : { limit: command.limit }),
})

const searchInput = (command: Args.ThreadCommand): ThreadService.SearchInput => ({
  ...(command.query === undefined ? {} : { query: command.query }),
  ...(command.include_archived === undefined ? {} : { include_archived: command.include_archived }),
  ...(command.limit === undefined ? {} : { limit: command.limit }),
})

interface SemanticSearchInput {
  readonly command: Args.ThreadCommand
  readonly output: Output.Interface
  readonly threads: ThreadService.Interface
  readonly embeddings?: Embeddings.Interface
  readonly memoryStore?: ThreadMemoryStore.Interface
}

interface SemanticSearchResult {
  readonly summary: ThreadService.ThreadSummary
  readonly score: number
  readonly matched: ReadonlyArray<string>
}

const semanticSearch = (
  input: SemanticSearchInput,
): Effect.Effect<ReadonlyArray<SemanticSearchResult> | undefined, RunError> =>
  Effect.gen(function* () {
    if (input.embeddings === undefined || input.memoryStore === undefined) {
      yield* input.output.stderr(
        "Semantic thread search unavailable: embeddings are not configured; using lexical search",
      )
      return undefined
    }
    const query = input.command.query?.trim() ?? ""
    const embedded = yield* input.embeddings.embed([query]).pipe(
      Effect.map((vectors) => vectors[0]),
      Effect.map((vector) =>
        vector === undefined
          ? { _tag: "unavailable" as const, reason: "embedding provider returned no vector" }
          : { _tag: "available" as const, vector },
      ),
      Effect.catchTag("EmbeddingsUnavailable", (error) =>
        Effect.succeed({ _tag: "unavailable" as const, reason: error.message }),
      ),
    )
    if (embedded._tag === "unavailable") {
      yield* input.output.stderr(`Semantic thread search unavailable: ${embedded.reason}; using lexical search`)
      return undefined
    }
    const rows = yield* input.memoryStore.search(embedded.vector, {
      limit: input.command.limit ?? 20,
    })
    const seen = new Set<string>()
    const results: Array<SemanticSearchResult> = []
    for (const row of rows) {
      if (seen.has(row.chunk.thread_id)) continue
      const record = yield* input.threads
        .preview({ thread_id: row.chunk.thread_id, limit: 1 })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (record === undefined) continue
      if (input.command.include_archived !== true && record.summary.archived) continue
      seen.add(row.chunk.thread_id)
      results.push({
        summary: record.summary,
        score: row.score,
        matched: [row.chunk.text.slice(0, 160)],
      })
    }
    return results
  })

const tournamentMessage = (input: Input.Interface, command: Args.ThreadCommand) =>
  command.message === undefined
    ? Effect.fail(new ThreadsError({ message: "Tournament message is required", action: command.action }))
    : command.message === "-"
      ? input.readAll.pipe(Effect.map((value) => value.trimEnd()))
      : Effect.succeed(command.message)

const withOrbStatus = (orbs: OrbStore.Interface, summary: ThreadService.ThreadSummary) =>
  orbs
    .getByThread(summary.thread_id)
    .pipe(Effect.map((orb) => (orb === undefined ? summary : { ...summary, orb_status: orb.status })))

const formatJson = (value: unknown) => JSON.stringify(value)
