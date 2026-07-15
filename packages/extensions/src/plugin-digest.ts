import { Crypto, Effect, Encoding, Schema } from "effect"
import type { Json, Tool } from "./plugin-api"

export class DigestError extends Schema.TaggedErrorClass<DigestError>()("@rika/extensions/PluginDigestError", {
  message: Schema.String,
}) {}

const canonical = (value: Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

export const value = Effect.fn("PluginDigest.value")(function* (input: string) {
  const crypto = yield* Crypto.Crypto
  const bytes = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(input))
    .pipe(Effect.mapError((cause) => DigestError.make({ message: String(cause) })))
  return Encoding.encodeHex(bytes)
})

export const source = (content: string) => value(content)
export const configuration = (config: Json) => value(canonical(config))
export const toolSchemas = (tools: ReadonlyArray<Tool>) =>
  value(
    tools
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(canonical)
      .join("\n"),
  )
