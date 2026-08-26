import { Function, Schema } from "effect"
import type { Run, RunEvent } from "tenetkit/runtime"
import { bounded, record } from "./values"
import { toolTextLimit } from "./values"

type ModelValue = Extract<RunEvent.RunEvent, { readonly _tag: "ToolExecutionStarted" }>["call"]["params"]

export const encoded = (value: ModelValue): string => {
  if (Schema.is(Schema.String)(value)) return bounded(value, toolTextLimit)
  try {
    return bounded(JSON.stringify(value) ?? "", toolTextLimit)
  } catch {
    return String(value)
  }
}

export const promptText = (value: ModelValue): string => {
  if (Schema.is(Schema.String)(value)) return value
  if (Array.isArray(value)) return value.map(promptText).filter(Boolean).join("\n")
  const object = record(value)
  if (Schema.is(Schema.String)(object.text)) return object.text
  return "content" in object ? promptText(object.content) : ""
}

export const token = (value: number | undefined): number | undefined =>
  value === undefined || !Number.isSafeInteger(value) || value < 0 ? undefined : value

const addImpl = (left: number | undefined, right: number | undefined): number | undefined => {
  if (right === undefined) return left
  const value = (left ?? 0) + right
  if (!Number.isSafeInteger(value)) throw new RangeError("TenetKit usage total exceeds the safe integer range")
  return value
}

export const providerCostNanoUsd = (value: RunEvent.RunEvent | Run.RawUsageFact): number | undefined => {
  const event = record(value)
  const usage = record(event.usage)
  const candidate = record(event.cost ?? event.providerCost ?? usage.cost)
  const amount = candidate.amount
  if (!Schema.is(Schema.Finite)(amount) || amount < 0 || candidate.currency !== "USD") return undefined
  const nanoUsd = Math.round(amount * 1_000_000_000)
  return Number.isSafeInteger(nanoUsd) ? nanoUsd : undefined
}

export const occurredAt = (event: RunEvent.RunEvent): number => {
  const value = Date.parse(event.occurredAt)
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError(`Invalid TenetKit lifecycle timestamp: ${event.eventId}`)
  return value
}

export const add: {
  (arg0: Parameters<typeof addImpl>[0], arg1: Parameters<typeof addImpl>[1]): ReturnType<typeof addImpl>
  (arg1: Parameters<typeof addImpl>[1]): (arg0: Parameters<typeof addImpl>[0]) => ReturnType<typeof addImpl>
} = Function.dual(2, addImpl)

export const hash = (value: string): string => {
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d]
  return seeds
    .map((seed) => {
      let result = seed >>> 0
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index)
        result = Math.imul(result, 0x01000193) >>> 0
      }
      return result.toString(16).padStart(8, "0")
    })
    .join("")
}

export const scopedId = (family: string, ...parts: ReadonlyArray<string | number>): string =>
  `${family}-${hash(parts.join("\u0000"))}`
