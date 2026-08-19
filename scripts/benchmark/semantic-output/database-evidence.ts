import { Database } from "bun:sqlite"
import type { SqlAccounting } from "./contract"

export interface FileAccounting {
  readonly database: number
  readonly wal: number
  readonly shm: number
  readonly total: number
}

export interface PageAccounting extends FileAccounting {
  readonly pageSize: number
  readonly pageCount: number
  readonly freelistCount: number
  readonly livePages: number
  readonly liveBytes: number
}

const fileBytes = (path: string): number => Bun.file(path).size

export const fileAccounting = (filename: string): FileAccounting => {
  const database = fileBytes(filename)
  const wal = fileBytes(`${filename}-wal`)
  const shm = fileBytes(`${filename}-shm`)
  return { database, wal, shm, total: database + wal + shm }
}

const pragmaNumber = (database: Database, name: string): number => {
  const row = database.query(`PRAGMA ${name}`).get() as Record<string, number> | null
  return row === null ? 0 : Number(Object.values(row)[0] ?? 0)
}

export const pageAccounting = (filename: string): PageAccounting => {
  const database = new Database(filename, { readonly: true, create: false })
  try {
    const pageSize = pragmaNumber(database, "page_size")
    const pageCount = pragmaNumber(database, "page_count")
    const freelistCount = pragmaNumber(database, "freelist_count")
    const livePages = pageCount - freelistCount
    return {
      ...fileAccounting(filename),
      pageSize,
      pageCount,
      freelistCount,
      livePages,
      liveBytes: pageSize * livePages,
    }
  } finally {
    database.close(false)
  }
}

export const passiveCheckpoint = (filename: string) => {
  const database = new Database(filename)
  try {
    const row = database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as Record<string, number> | null
    const values = row === null ? [] : Object.values(row).map(Number)
    return { busy: values[0] ?? 0, logFrames: values[1] ?? 0, checkpointedFrames: values[2] ?? 0 }
  } finally {
    database.close(false)
  }
}

const tableExists = (database: Database, table: string): boolean =>
  database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null

const resultBytes = (database: Database, table: string): number => {
  if (!tableExists(database, table)) return 0
  const row = database
    .query(`SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0) AS bytes FROM ${table}`)
    .get() as { readonly bytes: number }
  return Number(row.bytes)
}

export const sqlAccounting = (filename: string): SqlAccounting => {
  const database = new Database(filename, { readonly: true, create: false })
  try {
    if (!tableExists(database, "baton_run_events"))
      return {
        totalEvents: 0,
        eventsByTag: {},
        eventJsonBytes: 0,
        operationResultBytes: 0,
        modelPartEvents: 0,
        modelResponseCommittedEvents: 0,
      }
    const rows = database.query("SELECT event_json FROM baton_run_events ORDER BY run_id, sequence").all() as Array<{
      readonly event_json: string
    }>
    const eventsByTag: Record<string, number> = {}
    let eventJsonBytes = 0
    for (const row of rows) {
      eventJsonBytes += Buffer.byteLength(row.event_json)
      const value = JSON.parse(row.event_json) as { readonly _tag?: string }
      const tag = value._tag ?? "<missing>"
      eventsByTag[tag] = (eventsByTag[tag] ?? 0) + 1
    }
    return {
      totalEvents: rows.length,
      eventsByTag,
      eventJsonBytes,
      operationResultBytes:
        resultBytes(database, "baton_run_operations") + resultBytes(database, "baton_program_operations"),
      modelPartEvents: eventsByTag.ModelPart ?? 0,
      modelResponseCommittedEvents: eventsByTag.ModelResponseCommitted ?? 0,
    }
  } finally {
    database.close(false)
  }
}

export const fullEvidence = (filename: string) => {
  const beforeCheckpoint = pageAccounting(filename)
  const checkpoint = passiveCheckpoint(filename)
  const afterCheckpoint = pageAccounting(filename)
  return { beforeCheckpoint, checkpoint, afterCheckpoint }
}
