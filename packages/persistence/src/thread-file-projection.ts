import { Common, Event } from "@rika/schema"
import { Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { decodePayload } from "./thread-event-log"

type ThreadFileWriter = Pick<Database.DrizzleDatabase, "run">
type ThreadFileBackfillDatabase = Pick<Database.DrizzleDatabase, "all" | "run" | "transaction">

interface PayloadRow {
  readonly payload: string
}

export const applyThreadFiles = (database: ThreadFileWriter, event: Event.Event) => {
  for (const path of pathsFromEvent(event)) {
    database.run(sql`
      insert into thread_files (thread_id, path, first_seen_at, last_seen_at)
      values (${event.thread_id}, ${path}, ${event.created_at}, ${event.created_at})
      on conflict(thread_id, path) do update set last_seen_at = excluded.last_seen_at
    `)
  }
}

export const backfillThreadFiles = (database: ThreadFileBackfillDatabase) =>
  database.transaction((transaction) => {
    transaction
      .all<PayloadRow>(sql`select payload from thread_events order by thread_id asc, sequence asc`)
      .map((row) => decodePayload(row.payload))
      .forEach((event) => applyThreadFiles(transaction, event))
  })

const pathsFromEvent = (event: Event.Event): ReadonlyArray<string> => {
  if (event.type === "message.added") {
    return event.data.message.content.flatMap((part) => {
      if (part.type === "file-reference") return [part.path]
      if (part.type === "image" && part.filename !== undefined) return [part.filename]
      return []
    })
  }
  if (event.type === "context.resolved") {
    return event.data.entries.flatMap((entry) => (entry.path === undefined ? [] : [entry.path]))
  }
  if (event.type === "tool.call.requested") return pathsFromJson(event.data.call.input)
  if (event.type === "tool.call.input.ended") {
    const parsed = parseJson(event.data.input_text)
    return parsed === undefined ? [] : pathsFromJson(parsed)
  }
  if (event.type === "tool.call.completed" && event.data.result.output !== undefined) {
    return pathsFromJson(event.data.result.output)
  }
  return []
}

const pathsFromJson = (value: Common.JsonValue): ReadonlyArray<string> => {
  if (typeof value === "string") return looksLikePath(value) ? [normalizePath(value)] : []
  if (Array.isArray(value)) return value.flatMap(pathsFromJson)
  if (!isJsonObject(value)) return []
  return uniqueStrings(
    Object.entries(value).flatMap(([key, child]) =>
      isPathKey(key) && typeof child === "string" && looksLikePath(child)
        ? [normalizePath(child)]
        : pathsFromJson(child),
    ),
  )
}

const parseJson = (value: string): Common.JsonValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Option.getOrUndefined(Schema.decodeUnknownOption(Common.JsonValue)(parsed))
  } catch {
    return undefined
  }
}

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPathKey = (key: string) =>
  key === "path" || key === "file" || key === "filename" || key === "file_path" || key === "filepath"

const normalizePath = (value: string) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "")

const looksLikePath = (value: string) => {
  const normalized = normalizePath(value)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return false
  return normalized.includes("/") || /\.[A-Za-z0-9]+$/.test(normalized)
}

const uniqueStrings = (values: ReadonlyArray<string>) => [...new Set(values.filter((value) => value.length > 0))]
