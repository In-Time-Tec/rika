import { Function } from "effect"
import type { Node } from "../model"

export const subagentCardStatus = (status: Node["status"]): "running" | "complete" | "failed" | "cancelled" => {
  if (status === "completed") return "complete"
  if (status === "waiting") return "running"
  return status
}

const boundedInsertImpl = <A>(map: Map<string, A>, key: string, value: A, limit: number, label: string) => {
  const previous = map.get(key)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(value))
      throw new TypeError(`Conflicting Generalist ${label}: ${key}`)
    return false
  }
  if (map.size >= limit) throw new RangeError(`Generalist projector ${label} exceeds ${limit}`)
  map.set(key, value)
  return true
}

export const boundedInsert: {
  <A>(map: Map<string, A>, key: string, value: A, limit: number, label: string): boolean
  <A>(key: string, value: A, limit: number, label: string): (map: Map<string, A>) => boolean
} = Function.dual(5, boundedInsertImpl)
