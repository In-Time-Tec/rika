import { StringArray } from "@rika/core"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Option, Schema } from "effect"

export const maxDigestChars = 4_000

export const completedTurnDigest = (events: ReadonlyArray<Event.Event>, turnId: Ids.TurnId): Option.Option<string> => {
  if (!events.some((event) => event.type === "turn.completed" && event.turn_id === turnId)) return Option.none()
  const turnEvents = events.filter((event) => event.turn_id === turnId)
  const userText = turnEvents.flatMap((event) => roleText(event, "user")).join("\n")
  const assistantText = turnEvents.flatMap((event) => roleText(event, "assistant")).at(-1) ?? ""
  if (userText.length === 0 && assistantText.length === 0) return Option.none()
  const body = [userText, "---", assistantText].join("\n")
  const trailer = digestTrailer(turnEvents)
  const digest = trailer.length === 0 ? body : `${truncateBody(body, maxDigestChars - trailer.length)}${trailer}`
  return Option.some(digest.slice(0, maxDigestChars))
}

export const messageEntry = (event: Event.Event): ReadonlyArray<string> => {
  if (event.type !== "message.added") return []
  const text = messageText(event.data.message)
  return text.length === 0 ? [] : [`${event.data.message.role}: ${oneLine(text)}`]
}

export const toolEntries = (events: ReadonlyArray<Event.Event>) =>
  events.flatMap((event) => {
    if (event.type === "tool.call.requested") return [`Tool: ${event.data.call.name}`]
    if (event.type === "tool.call.completed")
      return [`Tool result: ${event.data.result.name} ${event.data.result.status}`]
    return []
  })

export const toolNames = (events: ReadonlyArray<Event.Event>) =>
  StringArray.uniqueNonEmptyStrings(
    events.flatMap((event) => {
      if (event.type === "tool.call.requested") return [event.data.call.name]
      if (event.type === "tool.call.completed") return [event.data.result.name]
      return []
    }),
  )

export const fileEntries = (events: ReadonlyArray<Event.Event>) =>
  StringArray.uniqueNonEmptyStrings(events.flatMap(pathsFromEvent))

export const pathsFromEvent = (event: Event.Event): ReadonlyArray<string> => {
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

export const pathsFromJson = (value: Common.JsonValue): ReadonlyArray<string> => {
  if (typeof value === "string") return looksLikePath(value) ? [normalizePath(value)] : []
  if (Array.isArray(value)) return value.flatMap(pathsFromJson)
  if (!isJsonObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    isPathKey(key) && typeof child === "string" && looksLikePath(child) ? [normalizePath(child)] : pathsFromJson(child),
  )
}

export const messageText = (message: Message.Message) => Message.displayText(message)

const roleText = (event: Event.Event, role: Message.Role): ReadonlyArray<string> => {
  if (event.type !== "message.added" || event.data.message.role !== role) return []
  const text = messageText(event.data.message).trim()
  return text.length === 0 ? [] : [text]
}

const digestTrailer = (events: ReadonlyArray<Event.Event>) => {
  const tools = toolNames(events)
  const files = fileEntries(events)
  const lines = [
    ...(tools.length === 0 ? [] : [`Tools: ${tools.join(", ")}`]),
    ...(files.length === 0 ? [] : [`Files: ${files.join(", ")}`]),
  ]
  return lines.length === 0 ? "" : `\n\n${lines.join("\n")}`
}

const truncateBody = (body: string, limit: number) => {
  if (limit <= 0) return ""
  return body.length <= limit ? body : body.slice(0, limit)
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()
const isPathKey = (key: string) =>
  key === "path" || key === "file" || key === "filename" || key === "file_path" || key === "filepath"
const normalizePath = (value: string) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
const looksLikePath = (value: string) => {
  const normalized = normalizePath(value)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return false
  return normalized.includes("/") || /\.[A-Za-z0-9]+$/.test(normalized)
}
const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (value: string): Common.JsonValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Option.getOrUndefined(Schema.decodeUnknownOption(Common.JsonValue)(parsed))
  } catch {
    return undefined
  }
}
