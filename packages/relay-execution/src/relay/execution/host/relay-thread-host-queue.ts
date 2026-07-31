import { Option, Schema } from "effect"
import { type Prompt } from "effect/unstable/ai"
import { waitToolName } from "./relay-thread-host-constants"

const QueueReadyMessageJson = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal("queue-ready"),
    thread_id: Schema.String,
    wake_generation: Schema.Int,
    queue_revision: Schema.Int,
  }),
)

export interface PendingQueueWake {
  readonly threadId: string
  readonly generation: number
  readonly queueRevision: number
}

export const pendingQueueWakes = (prompt: Prompt.Prompt): ReadonlyArray<PendingQueueWake> => {
  const last = prompt.content.at(-1)
  if (last === undefined || last.role !== "tool") return []
  const batch = last.content.findLast((part) => part.type === "tool-result" && part.name === waitToolName)
  if (batch === undefined || batch.type !== "tool-result") return []
  const text = JSON.stringify(batch.result ?? null)
  const wakes = new Map<string, PendingQueueWake>()
  for (const match of text.matchAll(/\{\\?"kind\\?"\s*:\s*\\?"queue-ready\\?"[^{}]*\}/g)) {
    const payload = Schema.decodeUnknownOption(QueueReadyMessageJson)(match[0].replaceAll('\\"', '"'))
    if (Option.isSome(payload) && payload.value.thread_id.length > 0)
      wakes.set(payload.value.thread_id, {
        threadId: payload.value.thread_id,
        generation: payload.value.wake_generation,
        queueRevision: payload.value.queue_revision,
      })
  }
  return [...wakes.values()]
}
