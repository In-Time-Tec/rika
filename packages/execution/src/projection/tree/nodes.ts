import { Function } from "effect"
import type { Node } from "../model"
import type { PersistedProjector } from "../persistence"

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

const compactNodeImpl = (node: Node, retained: ReadonlySet<string>): PersistedProjector["nodes"][number] => {
  const persisted: PersistedProjector["nodes"][number] = {
    rawRunId: node.rawRunId,
    publicId: node.publicId,
    hidden: node.hidden,
    phase: node.phase,
    status: node.status,
    lifecycle: node.lifecycle,
    started: node.started,
    tools: [...node.tools].filter(([, tool]) => retained.has(tool.key)),
    cells: [...node.cells].filter(([, cell]) => retained.has(cell.key)),
  }
  if (node.parentRawRunId !== undefined) Object.assign(persisted, { parentRawRunId: node.parentRawRunId })
  if (node.parentUnitKey !== undefined) Object.assign(persisted, { parentUnitKey: node.parentUnitKey })
  if (node.parentBlockId !== undefined) Object.assign(persisted, { parentBlockId: node.parentBlockId })
  if (node.attempt !== undefined) Object.assign(persisted, { attempt: node.attempt })
  return persisted
}

export const compactNode: {
  (
    arg0: Parameters<typeof compactNodeImpl>[0],
    arg1: Parameters<typeof compactNodeImpl>[1],
  ): ReturnType<typeof compactNodeImpl>
  (
    arg1: Parameters<typeof compactNodeImpl>[1],
  ): (arg0: Parameters<typeof compactNodeImpl>[0]) => ReturnType<typeof compactNodeImpl>
} = Function.dual(2, compactNodeImpl)

export const boundedInsert: {
  <A>(map: Map<string, A>, key: string, value: A, limit: number, label: string): boolean
  <A>(key: string, value: A, limit: number, label: string): (map: Map<string, A>) => boolean
} = Function.dual(5, boundedInsertImpl)
