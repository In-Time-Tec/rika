import { Common } from "@rika/schema"
import { Context, Effect, Layer } from "effect"

export interface Entry {
  readonly label: string
  readonly value: string
}

export interface Interface {
  readonly register: (entries: ReadonlyArray<Entry>) => Effect.Effect<void>
  readonly redact: (text: string) => string
  readonly redactJson: (value: Common.JsonValue) => Common.JsonValue
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/SecretRedactor") {}

export const secretEnvNamePattern =
  /(^DATABASE_URL$|^AWS_SECRET_ACCESS_KEY$|^STRIPE_SECRET_KEY$|(^|_)SECRET(_|$)|(^|_)TOKEN(_|$)|(^|_)PASSWORD(_|$)|(^|_)PASSWD(_|$)|_PASS$|(^|_)CREDENTIALS?(_|$)|(^|_)PRIVATE_KEY$|_APIKEY$|_KEY$)/i

const nonSecretEnvNamePattern = /((^|_)PUBLIC_KEY$|_URL$|_ID$)/i
const explicitSecretEnvNames = new Set(["DATABASE_URL", "AWS_SECRET_ACCESS_KEY", "STRIPE_SECRET_KEY"])
const explicitSecretEnvNamePattern = /(^|_)DATABASE_URL$/i

export const entriesFromEnv = (env: Record<string, string | undefined>): ReadonlyArray<Entry> =>
  Object.entries(env).flatMap(([label, value]) =>
    value !== undefined && isSecretEnvName(label) ? [{ label, value }] : [],
  )

export const isSecretEnvName = (label: string): boolean => {
  const normalized = label.toUpperCase()
  if (explicitSecretEnvNames.has(normalized) || explicitSecretEnvNamePattern.test(normalized)) return true
  return secretEnvNamePattern.test(normalized) && !nonSecretEnvNamePattern.test(normalized)
}

export const layerFromEntries = (initialEntries: ReadonlyArray<Entry>) =>
  Layer.effect(
    Service,
    Effect.sync(() => {
      let entries = normalizedEntries(initialEntries)
      const service = Service.of({
        register: Effect.fn("SecretRedactor.register")(function* (nextEntries: ReadonlyArray<Entry>) {
          yield* Effect.sync(() => {
            entries = normalizedEntries([...entries, ...nextEntries])
          })
        }),
        redact: (text: string) => redactWithEntries(entries, text),
        redactJson: (value: Common.JsonValue) => redactJsonWithEntries(entries, value),
      })
      return service
    }),
  )

export const layer = layerFromEntries([])

export const layerFromEnv = (env: Record<string, string | undefined>) => layerFromEntries(entriesFromEnv(env))

export const register = Effect.fn("SecretRedactor.register.call")(function* (entries: ReadonlyArray<Entry>) {
  const redactor = yield* Service
  return yield* redactor.register(entries)
})

export const redact = Effect.fn("SecretRedactor.redact.call")(function* (text: string) {
  const redactor = yield* Service
  return redactor.redact(text)
})

export const redactJson = Effect.fn("SecretRedactor.redactJson.call")(function* (value: Common.JsonValue) {
  const redactor = yield* Service
  return redactor.redactJson(value)
})

const normalizedEntries = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
  const byKey = new Map<string, Entry>()
  for (const entry of entries) {
    if (entry.value.length < 8) continue
    if (entry.label.length === 0) continue
    byKey.set(`${entry.label}\u0000${entry.value}`, entry)
  }
  return [...byKey.values()].toSorted(compareEntries)
}

const compareEntries = (left: Entry, right: Entry) => {
  const length = right.value.length - left.value.length
  if (length !== 0) return length
  const value = left.value.localeCompare(right.value)
  if (value !== 0) return value
  return left.label.localeCompare(right.label)
}

const redactWithEntries = (entries: ReadonlyArray<Entry>, text: string): string => {
  if (text.length === 0 || entries.length === 0) return text
  let redacted = ""
  let index = 0
  while (index < text.length) {
    const match = entries.find((entry) => text.startsWith(entry.value, index))
    if (match === undefined) {
      redacted += text[index] ?? ""
      index += 1
    } else {
      redacted += `[REDACTED:${match.label}]`
      index += match.value.length
    }
  }
  return redacted
}

const redactJsonWithEntries = (entries: ReadonlyArray<Entry>, value: Common.JsonValue): Common.JsonValue => {
  if (typeof value === "string") return redactWithEntries(entries, value)
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map((item) => redactJsonWithEntries(entries, item))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJsonWithEntries(entries, item)]))
}
