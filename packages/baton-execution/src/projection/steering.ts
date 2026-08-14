import type { RunEvent } from "@batonfx/runtime"
import * as Projection from "@rika/product/execution-projection"
import type { Unit } from "@rika/product/execution-transcript-contract"
import type { Node } from "./model"
import { boundedInsert } from "./nodes"

export interface SteeringProjection {
  readonly pending: Map<string, Projection.PendingSteering>
  readonly settled: Map<string, Projection.SteeringDisposition>
  readonly summary: (steeringMessages: number, followUpMessages: number) => Projection.SteeringSummary
  readonly accept: (runId: string, event: RunEvent.SteeringAccepted) => void
  readonly consume: (runId: string, event: RunEvent.SteeringConsumed, node: Node) => void
  readonly discard: (runId: string, event: RunEvent.SteeringDiscarded) => void
}

export const makeSteeringProjection = (input: {
  readonly turnId: string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
}): SteeringProjection => {
  const pending = new Map<string, Projection.PendingSteering>()
  const settled = new Map<string, Projection.SteeringDisposition>()
  const entryKey = (runId: string, entryId: string) => `${runId}\u0000${entryId}`

  const summary = (steeringMessages: number, followUpMessages: number): Projection.SteeringSummary => ({
    steeringMessages,
    followUpMessages,
    pending: [...pending.values()].toSorted(
      (left, right) =>
        left.sequence - right.sequence ||
        left.runId.localeCompare(right.runId) ||
        left.entryId.localeCompare(right.entryId),
    ),
    settled: [...settled.values()],
  })

  const settle = (key: string, outcome: Projection.SteeringDisposition["outcome"]) => {
    const steering = pending.get(key)
    if (steering === undefined) return undefined
    pending.delete(key)
    if (!settled.has(key) && settled.size >= Projection.PendingSteeringMaxEntries)
      settled.delete(settled.keys().next().value!)
    settled.set(key, {
      runId: steering.runId,
      entryId: steering.entryId,
      requestId: steering.requestId,
      sequence: steering.sequence,
      outcome,
    })
    return steering
  }

  const accept = (runId: string, event: RunEvent.SteeringAccepted) => {
    const text = event.prompt.content
      .flatMap((message) =>
        message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
      )
      .join("")
    if (text.length > Projection.SteeringTextMaxCharacters)
      throw new RangeError(`Baton projector steering text exceeds ${Projection.SteeringTextMaxCharacters}`)
    boundedInsert(
      pending,
      entryKey(runId, event.entryId),
      {
        runId,
        entryId: event.entryId,
        requestId: event.idempotencyKey,
        sequence: event.steeringSequence,
        text,
      },
      Projection.PendingSteeringMaxEntries,
      "pending steering entries",
    )
  }

  const consume = (runId: string, event: RunEvent.SteeringConsumed, node: Node) => {
    let orderPart = 0
    for (const entryId of event.entryIds) {
      const steering = settle(entryKey(runId, entryId), "consumed")
      if (steering === undefined) continue
      const unitKey = Projection.steeringUnitKey(
        input.turnId,
        steering.runId,
        steering.requestId,
        steering.entryId,
        steering.sequence,
      )
      input.put(input.unit(node, unitKey, { _tag: "Entry", role: "user", text: steering.text }, orderPart++))
    }
  }

  const discard = (runId: string, event: RunEvent.SteeringDiscarded) => {
    for (const entryId of event.entryIds) settle(entryKey(runId, entryId), "discarded")
  }

  return { pending, settled, summary, accept, consume, discard }
}
