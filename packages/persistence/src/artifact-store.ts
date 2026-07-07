import { Artifact, Common, Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { artifacts, thread_projections } from "./schema"

export const PutInput = Artifact.Artifact
export type PutInput = typeof PutInput.Type

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  kind: Schema.optional(Artifact.Kind),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Persistence.ArtifactStore.ListInput" })

export interface ListAllInput extends Schema.Schema.Type<typeof ListAllInput> {}
export const ListAllInput = Schema.Struct({
  workspace_id: Schema.optional(Ids.WorkspaceId),
  kind: Schema.optional(Artifact.Kind),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Persistence.ArtifactStore.ListAllInput" })

export class ArtifactStoreError extends Schema.TaggedErrorClass<ArtifactStoreError>()("ArtifactStoreError", {
  message: Schema.String,
  operation: Schema.String,
  artifact_id: Schema.optional(Ids.ArtifactId),
}) {}

export interface Interface {
  readonly put: (artifact: PutInput) => Effect.Effect<Artifact.Artifact, Database.DatabaseError | ArtifactStoreError>
  readonly get: (
    artifactId: Ids.ArtifactId,
  ) => Effect.Effect<Option.Option<Artifact.Artifact>, Database.DatabaseError | ArtifactStoreError>
  readonly list: (
    input: ListInput,
  ) => Effect.Effect<ReadonlyArray<Artifact.Artifact>, Database.DatabaseError | ArtifactStoreError>
  readonly listAll: (
    input?: ListAllInput,
  ) => Effect.Effect<ReadonlyArray<Artifact.Artifact>, Database.DatabaseError | ArtifactStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/ArtifactStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    return Service.of({
      put: Effect.fn("ArtifactStore.put")(function* (artifact: PutInput) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              const stored = artifactWithWorkspace(database, artifact)
              database.insert(artifacts).values(artifactToRow(stored)).onConflictDoNothing().run()
              return stored
            },
            catch: (cause) => toError(cause, "put", artifact.id),
          }),
        )
      }),
      get: Effect.fn("ArtifactStore.get")(function* (artifactId: Ids.ArtifactId) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => Option.fromNullishOr(rowToArtifact(database.get<ArtifactRow>(selectById(artifactId)))),
            catch: (cause) => toError(cause, "get", artifactId),
          }),
        )
      }),
      list: Effect.fn("ArtifactStore.list")(function* (input: ListInput) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => listRows(database, input),
            catch: (cause) => toError(cause, "list"),
          }),
        )
      }),
      listAll: Effect.fn("ArtifactStore.listAll")(function* (input: ListAllInput = {}) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => listAllRows(database, input),
            catch: (cause) => toError(cause, "listAll"),
          }),
        )
      }),
    })
  }),
)

export const memoryLayer = layer.pipe(Layer.provideMerge(Database.memoryLayer))

export const fakeLayer = (initial: ReadonlyArray<Artifact.Artifact> = []) => {
  const rows = new Map(initial.map((artifact) => [artifact.id, artifact]))
  return Layer.succeed(
    Service,
    Service.of({
      put: Effect.fn("ArtifactStore.put.fake")(function* (artifact: PutInput) {
        yield* Effect.sync(() => rows.set(artifact.id, artifact))
        return artifact
      }),
      get: Effect.fn("ArtifactStore.get.fake")(function* (artifactId: Ids.ArtifactId) {
        return Option.fromNullishOr(rows.get(artifactId))
      }),
      list: Effect.fn("ArtifactStore.list.fake")(function* (input: ListInput) {
        return [...rows.values()]
          .filter((artifact) => artifact.thread_id === input.thread_id)
          .filter((artifact) => input.kind === undefined || artifact.kind === input.kind)
          .toSorted(compareNewest)
          .slice(0, input.limit ?? 100)
      }),
      listAll: Effect.fn("ArtifactStore.listAll.fake")(function* (input: ListAllInput = {}) {
        return [...rows.values()]
          .filter((artifact) => input.workspace_id === undefined || artifact.workspace_id === input.workspace_id)
          .filter((artifact) => input.kind === undefined || artifact.kind === input.kind)
          .toSorted(compareNewest)
          .slice(0, input.limit ?? 100)
      }),
    }),
  )
}

export const put = Effect.fn("ArtifactStore.put.call")(function* (artifact: PutInput) {
  const store = yield* Service
  return yield* store.put(artifact)
})

export const get = Effect.fn("ArtifactStore.get.call")(function* (artifactId: Ids.ArtifactId) {
  const store = yield* Service
  return yield* store.get(artifactId)
})

export const list = Effect.fn("ArtifactStore.list.call")(function* (input: ListInput) {
  const store = yield* Service
  return yield* store.list(input)
})

export const listAll = Effect.fn("ArtifactStore.listAll.call")(function* (input: ListAllInput = {}) {
  const store = yield* Service
  return yield* store.listAll(input)
})

type ArtifactDatabase = Pick<Database.DrizzleDatabase, "get" | "insert" | "all">

interface ArtifactRow {
  readonly id: string
  readonly thread_id: string
  readonly workspace_id: string | null
  readonly turn_id: string | null
  readonly kind: string
  readonly title: string | null
  readonly content: string
  readonly metadata: string | null
  readonly created_at: number
}

interface ThreadWorkspaceRow {
  readonly workspace_id: string
}

const selectById = (artifactId: Ids.ArtifactId) => sql`select * from artifacts where id = ${artifactId} limit 1`

const listRows = (database: ArtifactDatabase, input: ListInput) => {
  const limit = input.limit ?? 100
  const rows =
    input.kind === undefined
      ? database.all<ArtifactRow>(
          sql`select * from artifacts where thread_id = ${input.thread_id} order by created_at desc, id desc limit ${limit}`,
        )
      : database.all<ArtifactRow>(
          sql`select * from artifacts where thread_id = ${input.thread_id} and kind = ${input.kind} order by created_at desc, id desc limit ${limit}`,
        )
  return rows.flatMap((row) => {
    const artifact = rowToArtifact(row)
    return artifact === undefined ? [] : [artifact]
  })
}

const listAllRows = (database: ArtifactDatabase, input: ListAllInput) => {
  const limit = input.limit ?? 100
  const rows = listAllRowsByFilter(database, input, limit)
  return rows.flatMap((row) => {
    const artifact = rowToArtifact(row)
    return artifact === undefined ? [] : [artifact]
  })
}

const listAllRowsByFilter = (database: ArtifactDatabase, input: ListAllInput, limit: number) => {
  if (input.workspace_id !== undefined && input.kind !== undefined) {
    return database.all<ArtifactRow>(
      sql`select * from artifacts where workspace_id = ${input.workspace_id} and kind = ${input.kind} order by created_at desc, id desc limit ${limit}`,
    )
  }
  if (input.workspace_id !== undefined) {
    return database.all<ArtifactRow>(
      sql`select * from artifacts where workspace_id = ${input.workspace_id} order by created_at desc, id desc limit ${limit}`,
    )
  }
  if (input.kind !== undefined) {
    return database.all<ArtifactRow>(
      sql`select * from artifacts where kind = ${input.kind} order by created_at desc, id desc limit ${limit}`,
    )
  }
  return database.all<ArtifactRow>(sql`select * from artifacts order by created_at desc, id desc limit ${limit}`)
}

const compareNewest = (left: Artifact.Artifact, right: Artifact.Artifact) =>
  right.created_at - left.created_at || right.id.localeCompare(left.id)

const artifactToRow = (artifact: Artifact.Artifact) => ({
  id: artifact.id,
  thread_id: artifact.thread_id,
  workspace_id: artifact.workspace_id ?? null,
  turn_id: artifact.turn_id ?? null,
  kind: artifact.kind,
  title: artifact.title ?? null,
  content: JSON.stringify(artifact.content),
  metadata: artifact.metadata === undefined ? null : JSON.stringify(artifact.metadata),
  created_at: artifact.created_at,
})

const artifactWithWorkspace = (database: ArtifactDatabase, artifact: Artifact.Artifact): Artifact.Artifact => {
  if (artifact.workspace_id !== undefined) return artifact
  const row = database.get<ThreadWorkspaceRow>(
    sql`select ${thread_projections.workspace_id} from ${thread_projections} where ${thread_projections.thread_id} = ${artifact.thread_id} limit 1`,
  )
  if (row === undefined) {
    throw new ArtifactStoreError({
      message: `Thread ${artifact.thread_id} is not present in thread_projections`,
      operation: "put",
      artifact_id: artifact.id,
    })
  }
  return { ...artifact, workspace_id: Ids.WorkspaceId.make(row.workspace_id) }
}

const rowToArtifact = (row: ArtifactRow | undefined): Artifact.Artifact | undefined => {
  if (row === undefined) return undefined
  const content = decodeJson(row.content)
  if (Option.isNone(content)) return undefined
  const metadata = row.metadata === null ? undefined : decodeMetadata(row.metadata)
  if (metadata !== undefined && Option.isNone(metadata)) return undefined
  const kind = Schema.decodeUnknownOption(Artifact.Kind)(row.kind)
  if (Option.isNone(kind)) return undefined
  return {
    id: Ids.ArtifactId.make(row.id),
    thread_id: Ids.ThreadId.make(row.thread_id),
    ...(row.workspace_id === null ? {} : { workspace_id: Ids.WorkspaceId.make(row.workspace_id) }),
    ...(row.turn_id === null ? {} : { turn_id: Ids.TurnId.make(row.turn_id) }),
    kind: kind.value,
    ...(row.title === null ? {} : { title: row.title }),
    content: content.value,
    created_at: Common.TimestampMillis.make(row.created_at),
    ...(metadata === undefined ? {} : { metadata: metadata.value }),
  }
}

const decodeJson = (value: string) => {
  const parsed = parseJson(value)
  if (Option.isNone(parsed)) return Option.none<Common.JsonValue>()
  return Schema.decodeUnknownOption(Common.JsonValue)(parsed.value)
}

const decodeMetadata = (value: string) => {
  const parsed = parseJson(value)
  if (Option.isNone(parsed)) return Option.none<Common.Metadata>()
  return Schema.decodeUnknownOption(Common.Metadata)(parsed.value)
}

const parseJson = (value: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(value))
  } catch {
    return Option.none()
  }
}

const toError = (cause: unknown, operation: string, artifactId?: Ids.ArtifactId) => {
  if (cause instanceof ArtifactStoreError) return cause
  return new ArtifactStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(artifactId === undefined ? {} : { artifact_id: artifactId }),
  })
}
