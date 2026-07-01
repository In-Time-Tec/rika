import { open, readFile, stat } from "node:fs/promises"
import { Effect } from "effect"
import * as Args from "./args"
import * as Output from "./output"

interface Entry {
  readonly emitted_at?: string
  readonly level: string
  readonly message: string
  readonly data?: unknown
}

const levelRank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export const resolveLogPath = (
  env: Record<string, string | undefined>,
  cwd: string,
  workspaceRootOverride?: string,
): string => {
  const fromRika = env.RIKA_LOG_FILE
  if (fromRika !== undefined && fromRika.length > 0) return fromRika
  const fromAmp = env.AMP_LOG_FILE
  if (fromAmp !== undefined && fromAmp.length > 0) return fromAmp
  const workspaceRoot = workspaceRootOverride ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  return `${dataDir}/logs/session.ndjson`
}

export const executeCommand = Effect.fn("Cli.Logs.executeCommand")(function* (
  command: Args.LogsCommand,
  env: Record<string, string | undefined>,
  cwd: string,
) {
  const path = resolveLogPath(env, cwd, command.workspace_root)
  const text = yield* readFileOption(path)
  if (text === undefined) {
    yield* Output.stderr(`No telemetry log found at ${path}. Run a Rika command first, then re-run 'rika logs'.`)
    return 0
  }
  const limit = command.limit ?? 200
  const cutoff = command.since === undefined ? undefined : cutoffFromSince(command.since)
  const matches = parseLines(text).filter((entry) => matchesFilters(entry, command, cutoff))
  for (const entry of matches.slice(-limit)) yield* emitEntry(entry, command.json)
  if (!command.follow) return 0
  yield* followFrom(path, byteLength(text), command, cutoff)
  return 0
})

const followFrom = (path: string, startOffset: number, command: Args.LogsCommand, cutoff: number | undefined) =>
  Effect.gen(function* () {
    let position = startOffset
    while (true) {
      yield* Effect.sleep("400 millis")
      const size = yield* sizeOption(path)
      if (size === undefined) continue
      if (size < position) position = 0
      if (size <= position) continue
      const chunk = yield* readRange(path, position, size)
      position = size
      for (const line of chunk.split("\n")) {
        if (line.length === 0) continue
        const entry = parseLine(line)
        if (entry !== undefined && matchesFilters(entry, command, cutoff)) yield* emitEntry(entry, command.json)
      }
    }
  })

const emitEntry = (entry: Entry, json: boolean) =>
  json ? Output.stdout(JSON.stringify(entry)) : Output.stdout(formatEntry(entry))

const matchesFilters = (entry: Entry, command: Args.LogsCommand, cutoff: number | undefined): boolean => {
  if (command.level !== undefined && (levelRank[entry.level] ?? 0) < (levelRank[command.level] ?? 0)) return false
  if (command.op !== undefined && dataField(entry, "op") !== command.op) return false
  if (command.thread_id !== undefined && dataField(entry, "thread_id") !== command.thread_id) return false
  if (cutoff !== undefined && entry.emitted_at !== undefined) {
    const at = Date.parse(entry.emitted_at)
    if (!Number.isNaN(at) && at < cutoff) return false
  }
  return true
}

const formatEntry = (entry: Entry): string => {
  const time = entry.emitted_at === undefined ? "".padEnd(12) : entry.emitted_at.slice(11, 23)
  const level = entry.level.toUpperCase().padEnd(5)
  const parts = [time, level, entry.message]
  const data = entry.data
  if (isRecord(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (key === "op" || key === "outcome") continue
      parts.push(`${key}=${scalar(value)}`)
    }
  } else if (data !== undefined) {
    parts.push(JSON.stringify(data))
  }
  return parts.join("  ")
}

const scalar = (value: unknown): string =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value)

const dataField = (entry: Entry, key: string): unknown => (isRecord(entry.data) ? entry.data[key] : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseLines = (text: string): ReadonlyArray<Entry> => {
  const entries: Array<Entry> = []
  for (const line of text.split("\n")) {
    const entry = parseLine(line)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

const parseLine = (line: string): Entry | undefined => {
  if (line.trim().length === 0) return undefined
  try {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value) || typeof value.level !== "string" || typeof value.message !== "string") return undefined
    const emittedAt = typeof value.emitted_at === "string" ? value.emitted_at : undefined
    return {
      level: value.level,
      message: value.message,
      data: value.data,
      ...(emittedAt === undefined ? {} : { emitted_at: emittedAt }),
    }
  } catch {
    return undefined
  }
}

const cutoffFromSince = (since: string): number | undefined => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(since.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = match[2]
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return Date.now() - amount * scale
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8")

const readFileOption = (path: string) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.orElseSucceed((): string | undefined => undefined))

const sizeOption = (path: string) =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map((info): number | undefined => info.size),
    Effect.orElseSucceed((): number | undefined => undefined),
  )

const readRange = (path: string, start: number, end: number) =>
  Effect.tryPromise(async () => {
    const handle = await open(path, "r")
    try {
      const length = end - start
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return buffer.toString("utf8")
    } finally {
      await handle.close()
    }
  }).pipe(Effect.orElseSucceed(() => ""))
