import { Database as BunSqliteDatabase } from "bun:sqlite"
import { sql } from "drizzle-orm"
import type * as Database from "./database"

export interface ImportResult {
  readonly imported_events: number
  readonly skipped_events: number
  readonly imported_artifacts: number
  readonly skipped_artifacts: number
}

export const importFromSqlite = (database: Database.DrizzleDatabase, sourcePath: string): ImportResult => {
  const source = new BunSqliteDatabase(sourcePath, { readonly: true })
  try {
    const events = readSourceEvents(source)
    const artifacts = readSourceArtifacts(source)
    return database.transaction((transaction) => ({
      ...copyEvents(transaction, events),
      ...copyArtifacts(transaction, artifacts),
    }))
  } finally {
    source.close()
  }
}

type ImportDatabase = Pick<Database.DrizzleDatabase, "get" | "run">

interface SourceThreadEventRow {
  readonly id: string
  readonly thread_id: string
  readonly turn_id: string | null
  readonly sequence: number
  readonly version: number
  readonly type: string
  readonly payload: string
  readonly message_id: string | null
  readonly tool_call_id: string | null
  readonly artifact_id: string | null
  readonly created_at: number
}

interface SourceArtifactRow {
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

interface ChangesRow {
  readonly changes: number
}

interface ColumnNameRow {
  readonly name: string
}

const artifactColumns = ["id", "thread_id", "turn_id", "kind", "title", "content", "metadata", "created_at"]

const readSourceEvents = (source: BunSqliteDatabase): ReadonlyArray<SourceThreadEventRow> => {
  if (!tableExists(source, "thread_events")) {
    throw new Error("Source database has no thread_events table")
  }
  return source
    .query<
      SourceThreadEventRow,
      []
    >("select id, thread_id, turn_id, sequence, version, type, payload, message_id, tool_call_id, artifact_id, created_at from thread_events order by thread_id asc, sequence asc")
    .all()
}

const readSourceArtifacts = (source: BunSqliteDatabase): ReadonlyArray<SourceArtifactRow> => {
  if (!tableExists(source, "artifacts")) return []
  const columns = new Set(
    source
      .query<ColumnNameRow, []>("select name from pragma_table_info('artifacts')")
      .all()
      .map((row) => row.name),
  )
  if (!artifactColumns.every((column) => columns.has(column))) return []
  const workspaceColumn = columns.has("workspace_id") ? "workspace_id" : "null as workspace_id"
  return source
    .query<
      SourceArtifactRow,
      []
    >(`select id, thread_id, ${workspaceColumn}, turn_id, kind, title, content, metadata, created_at from artifacts order by created_at asc, id asc`)
    .all()
}

const copyEvents = (database: ImportDatabase, rows: ReadonlyArray<SourceThreadEventRow>) => {
  let imported_events = 0
  let skipped_events = 0
  for (const row of rows) {
    database.run(sql`
      insert or ignore into thread_events (
        id,
        thread_id,
        turn_id,
        sequence,
        version,
        type,
        payload,
        message_id,
        tool_call_id,
        artifact_id,
        created_at
      ) values (
        ${row.id},
        ${row.thread_id},
        ${row.turn_id},
        ${row.sequence},
        ${row.version},
        ${row.type},
        ${row.payload},
        ${row.message_id},
        ${row.tool_call_id},
        ${row.artifact_id},
        ${row.created_at}
      )
    `)
    if (lastChanges(database) === 1) imported_events += 1
    else skipped_events += 1
  }
  return { imported_events, skipped_events }
}

const copyArtifacts = (database: ImportDatabase, rows: ReadonlyArray<SourceArtifactRow>) => {
  let imported_artifacts = 0
  let skipped_artifacts = 0
  for (const row of rows) {
    database.run(sql`
      insert or ignore into artifacts (
        id,
        thread_id,
        workspace_id,
        turn_id,
        kind,
        title,
        content,
        metadata,
        created_at
      ) values (
        ${row.id},
        ${row.thread_id},
        ${row.workspace_id},
        ${row.turn_id},
        ${row.kind},
        ${row.title},
        ${row.content},
        ${row.metadata},
        ${row.created_at}
      )
    `)
    if (lastChanges(database) === 1) imported_artifacts += 1
    else skipped_artifacts += 1
  }
  return { imported_artifacts, skipped_artifacts }
}

const lastChanges = (database: ImportDatabase) => database.get<ChangesRow>(sql`select changes() as changes`)?.changes

const tableExists = (source: BunSqliteDatabase, name: string) =>
  source.query("select name from sqlite_master where type = 'table' and name = ?1").get(name) !== null
