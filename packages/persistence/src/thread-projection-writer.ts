import { Common, Event, Message } from "@rika/schema"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { decodePayload } from "./thread-event-codec"
import { ThreadProjectionError } from "./thread-projection-error"
import * as ThreadFileProjection from "./thread-file-projection"

type ProjectionDatabase = Pick<Database.DrizzleDatabase, "all" | "get" | "run">

interface PayloadRow {
  readonly payload: string
}

interface ProjectionSequenceRow {
  readonly last_sequence: number
}

interface DiffStats {
  readonly additions: number
  readonly modifications: number
  readonly deletions: number
}

export const applyEvent = (database: Database.DrizzleDatabase, event: Event.Event) =>
  database.transaction((transaction) => applyEventRow(transaction, event))

export const rebuildProjection = (database: Database.DrizzleDatabase) =>
  database.transaction((transaction) => {
    clearProjectionRows(transaction)
    transaction
      .all<PayloadRow>(sql`select payload from thread_events order by thread_id asc, sequence asc`)
      .map((row) => decodePayload(row.payload))
      .forEach((event) => applyEventRow(transaction, event))
  })

export const clearProjection = (database: Database.DrizzleDatabase) =>
  database.transaction((transaction) => clearProjectionRows(transaction))

export const clearProjectionRows = (database: ProjectionDatabase) => {
  database.run(sql`delete from thread_files`)
  database.run(sql`delete from thread_projections`)
}

export const applyEventRow = (database: ProjectionDatabase, event: Event.Event) => {
  const row = database.get<ProjectionSequenceRow>(
    sql`select last_sequence from thread_projections where thread_id = ${event.thread_id}`,
  )

  if (row === undefined) return applyFirstEvent(database, event)
  if (event.sequence <= row.last_sequence) return undefined
  if (event.sequence !== row.last_sequence + 1) {
    throw new ThreadProjectionError({
      message: `Expected projection sequence ${row.last_sequence + 1} for thread ${event.thread_id}, received ${event.sequence}`,
      operation: "apply",
      thread_id: event.thread_id,
    })
  }

  ThreadFileProjection.applyThreadFiles(database, event)

  switch (event.type) {
    case "message.added":
      return applyMessageAdded(database, event)
    case "tool.call.completed":
      return applyToolCallCompleted(database, event)
    case "turn.started":
      return applyTurnStarted(database, event)
    case "turn.completed":
      return applyTurnCompleted(database, event)
    case "turn.failed":
      return applyTurnFailed(database, event)
    case "model.stream.chunk":
    case "model.reasoning.delta":
      return applyModelSeen(database, event)
    case "thread.archived":
      return applyThreadArchived(database, event)
    case "thread.unarchived":
      return applyThreadUnarchived(database, event)
    case "thread.visibility.set":
      return applyThreadVisibilitySet(database, event)
    default:
      return applySequenceOnly(database, event)
  }
}

const applyFirstEvent = (database: ProjectionDatabase, event: Event.Event) => {
  if (event.type !== "thread.created") {
    throw new ThreadProjectionError({
      message: `Cannot apply ${event.type} before thread.created for thread ${event.thread_id}`,
      operation: "apply",
      thread_id: event.thread_id,
    })
  }
  if (event.sequence !== 1) {
    throw new ThreadProjectionError({
      message: `Expected first projection sequence 1 for thread ${event.thread_id}, received ${event.sequence}`,
      operation: "apply",
      thread_id: event.thread_id,
    })
  }
  return applyThreadCreated(database, event)
}

const applyThreadCreated = (database: ProjectionDatabase, event: Event.ThreadCreated) =>
  database.run(sql`
    insert into thread_projections (thread_id, workspace_id, user_id, last_user_id, title_text, archived, visibility, last_sequence, created_at, updated_at)
    values (${event.thread_id}, ${event.data.workspace_id}, ${event.data.user_id ?? null}, ${event.data.user_id ?? null}, ${event.data.title_text ?? null}, 0, 'private', ${event.sequence}, ${event.created_at}, ${event.created_at})
  `)

const applyMessageAdded = (database: ProjectionDatabase, event: Event.MessageAdded) => {
  const userId = messageUserId(event)
  return database.run(sql`
    update thread_projections set
      latest_message_id = ${event.data.message.id},
      latest_message_role = ${event.data.message.role},
      latest_message_text = ${messageText(event.data.message)},
      latest_message_created_at = ${event.data.message.created_at},
      last_user_id = case
        when ${userId} is null then last_user_id
        else ${userId}
      end,
      title_text = case
        when title_text is null then ${titleText(event.data.message) ?? null}
        else title_text
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)
}

const applyToolCallCompleted = (database: ProjectionDatabase, event: Event.ToolCallCompleted) => {
  const diff = diffStatsFromValue(event.data.result.output)
  if (isEmptyDiff(diff)) return applySequenceOnly(database, event)
  return database.run(sql`
    update thread_projections set
      diff_additions = diff_additions + ${diff.additions},
      diff_modifications = diff_modifications + ${diff.modifications},
      diff_deletions = diff_deletions + ${diff.deletions},
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)
}

const applyTurnStarted = (database: ProjectionDatabase, event: Event.TurnStarted) =>
  database.run(sql`
    update thread_projections set
      active_turn_id = ${event.turn_id},
      active_turn_status = 'active',
      last_user_id = case
        when ${event.data.user_id ?? null} is null then last_user_id
        else ${event.data.user_id ?? null}
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyTurnFailed = (database: ProjectionDatabase, event: Event.TurnFailed) =>
  database.run(sql`
    update thread_projections set
      active_turn_id = case
        when active_turn_id is null then ${event.turn_id}
        else active_turn_id
      end,
      active_turn_status = case
        when active_turn_id is null then 'failed'
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') then 'failed'
        else active_turn_status
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyTurnCompleted = (database: ProjectionDatabase, event: Event.TurnCompleted) => {
  const inputTokens = event.data.usage?.input_tokens ?? null
  const model = event.data.model ?? null
  return database.run(sql`
    update thread_projections set
      active_turn_id = case
        when active_turn_id is null then ${event.turn_id}
        else active_turn_id
      end,
      active_turn_status = case
        when active_turn_id is null then 'completed'
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') then 'completed'
        else active_turn_status
      end,
      last_context_tokens = case
        when active_turn_id is null and ${inputTokens} is not null then ${inputTokens}
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') and ${inputTokens} is not null then ${inputTokens}
        else last_context_tokens
      end,
      last_model = case
        when active_turn_id is null and ${model} is not null then ${model}
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') and ${model} is not null then ${model}
        else last_model
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)
}

const applyModelSeen = (database: ProjectionDatabase, event: Event.ModelStreamChunk | Event.ModelReasoningDelta) =>
  database.run(sql`
    update thread_projections set
      last_model = ${event.data.model},
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyThreadArchived = (database: ProjectionDatabase, event: Event.ThreadArchived) =>
  database.run(sql`
    update thread_projections set
      archived = 1,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyThreadUnarchived = (database: ProjectionDatabase, event: Event.ThreadUnarchived) =>
  database.run(sql`
    update thread_projections set
      archived = 0,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyThreadVisibilitySet = (database: ProjectionDatabase, event: Event.ThreadVisibilitySet) =>
  database.run(sql`
    update thread_projections set
      visibility = ${event.data.visibility},
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applySequenceOnly = (database: ProjectionDatabase, event: Event.Event) =>
  database.run(sql`
    update thread_projections set
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const messageText = (message: Message.Message) => Message.displayText(message)

const messageUserId = (event: Event.MessageAdded) => {
  if (event.data.message.role !== "user") return null
  const userId = event.data.message.metadata?.user_id
  return typeof userId === "string" && userId.length > 0 ? userId : null
}

const titleText = (message: Message.Message): string | undefined => {
  if (message.role !== "user") return undefined
  const text = readableText(messageText(message))
  if (text === undefined) return undefined
  return oneLine(text, 96)
}

const readableText = (value: string): string | undefined => {
  const text = value.replace(/\r\n?/g, "\n").trim()
  if (text.length === 0) return undefined
  if (isRawToolPayload(text)) return undefined
  return text
}

const oneLine = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3))}...`
}

const isRawToolPayload = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  return trimmed.includes('"tool_call"') || trimmed.includes('"tool_result"')
}

const emptyDiff: DiffStats = { additions: 0, modifications: 0, deletions: 0 }

const diffStatsFromValue = (value: Common.JsonValue | undefined): DiffStats => {
  if (Array.isArray(value)) {
    return value.reduce(addNestedDiffStats, emptyDiff)
  }
  if (!isJsonObject(value)) return emptyDiff
  if (isPierreDiff(value)) return diffStatsFromFileDiff(value.file_diff)
  return Object.values(value).reduce(addNestedDiffStats, emptyDiff)
}

const diffStatsFromFileDiff = (value: Common.JsonValue | undefined): DiffStats => {
  if (!isJsonObject(value)) return emptyDiff
  return arrayField(value, "hunks")?.filter(isJsonObject).reduce(addHunkDiffStats, emptyDiff) ?? emptyDiff
}

const diffStatsFromHunk = (hunk: Record<string, Common.JsonValue>): DiffStats =>
  arrayField(hunk, "hunkContent")?.filter(isJsonObject).reduce(addHunkContentDiffStats, emptyDiff) ?? emptyDiff

const addNestedDiffStats = (total: DiffStats, item: Common.JsonValue): DiffStats =>
  addDiffStats(total, diffStatsFromValue(item))

const addHunkDiffStats = (total: DiffStats, hunk: Record<string, Common.JsonValue>): DiffStats =>
  addDiffStats(total, diffStatsFromHunk(hunk))

const addHunkContentDiffStats = (total: DiffStats, content: Record<string, Common.JsonValue>): DiffStats => {
  if (content.type !== "change") return total
  const additions = numberField(content, "additions") ?? 0
  const deletions = numberField(content, "deletions") ?? 0
  return addDiffStats(total, { additions, modifications: Math.min(additions, deletions), deletions })
}

const addDiffStats = (left: DiffStats, right: DiffStats): DiffStats => ({
  additions: left.additions + right.additions,
  modifications: left.modifications + right.modifications,
  deletions: left.deletions + right.deletions,
})

const isEmptyDiff = (diff: DiffStats): boolean =>
  diff.additions === 0 && diff.modifications === 0 && diff.deletions === 0

const isPierreDiff = (value: Record<string, Common.JsonValue>) =>
  value.kind === "diff" && value.renderer === "@pierre/diffs"

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const arrayField = (
  value: Record<string, Common.JsonValue>,
  key: string,
): ReadonlyArray<Common.JsonValue> | undefined => (Array.isArray(value[key]) ? value[key] : undefined)

const numberField = (value: Record<string, Common.JsonValue>, key: string): number | undefined =>
  typeof value[key] === "number" ? value[key] : undefined
