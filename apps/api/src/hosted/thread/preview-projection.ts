import * as ExecutionGateway from "@rika/product/execution-gateway"
import { ThreadId } from "@rika/product/hosted-model"
import * as Turn from "@rika/product/turn-record"
import { Encoding, Result, Schema } from "effect"

const reassemblyCapacity = 256

export interface HostedPreview {
  readonly threadId: ThreadId
  readonly turnId: Turn.TurnId
  readonly preview: ExecutionGateway.ModelPreviewEvent
}

export const HostedPreviewSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: Turn.TurnId,
  preview: ExecutionGateway.ModelPreviewEvent,
})

export const PreviewFragment = Schema.Struct({
  source: Schema.String,
  id: Schema.String,
  threadId: ThreadId,
  index: Schema.Int,
  count: Schema.Int,
  data: Schema.String,
})
export type PreviewFragment = typeof PreviewFragment.Type

interface Reassembly {
  readonly fragment: PreviewFragment
  readonly parts: Array<string | undefined>
}

const validFragment = (fragment: PreviewFragment) =>
  fragment.count >= 1 && fragment.count <= 16 && fragment.index >= 0 && fragment.index < fragment.count

export const projectPreviewFragments = (local: {
  readonly hasSubscribers: (threadId: ThreadId) => boolean
  readonly publishLocal: (preview: HostedPreview) => void
  readonly resetLocal: (threadId: ThreadId) => void
}) => {
  const reassembly = new Map<string, Reassembly>()
  const latest = new Map<string, string>()
  const streamFor = (fragment: PreviewFragment) => `${fragment.source}:${fragment.threadId}`
  const discard = (id: string, fragment: PreviewFragment) => {
    reassembly.delete(id)
    const stream = streamFor(fragment)
    if (latest.get(stream) === id) latest.delete(stream)
  }
  const reset = (fragment: PreviewFragment) => {
    discard(fragment.id, fragment)
    local.resetLocal(fragment.threadId)
  }
  const evictOldest = () => {
    if (reassembly.size < reassemblyCapacity) return
    const id = reassembly.keys().next().value
    if (id === undefined) return
    const evicted = reassembly.get(id)
    if (evicted !== undefined) reset(evicted.fragment)
  }
  const obtain = (fragment: PreviewFragment) => {
    const existing = reassembly.get(fragment.id)
    if (existing !== undefined) return existing
    evictOldest()
    const created = { fragment, parts: Array.from<string | undefined>({ length: fragment.count }) }
    reassembly.set(fragment.id, created)
    return created
  }
  const projectComplete = (current: Reassembly, fragment: PreviewFragment) => {
    if (current.parts.some((part) => part === undefined)) return
    discard(fragment.id, fragment)
    const decoded = Result.getOrUndefined(Encoding.decodeBase64String(current.parts.join("")))
    const preview =
      decoded === undefined ? undefined : Schema.decodeOption(Schema.fromJsonString(HostedPreviewSchema))(decoded)
    if (preview?._tag === "Some" && preview.value.threadId === fragment.threadId) local.publishLocal(preview.value)
    else local.resetLocal(fragment.threadId)
  }
  return (fragment: PreviewFragment) => {
    if (!validFragment(fragment)) return
    const stream = streamFor(fragment)
    if (!local.hasSubscribers(fragment.threadId)) {
      const stale = latest.get(stream)
      if (stale !== undefined) discard(stale, fragment)
      return
    }
    const previous = latest.get(stream)
    if (fragment.index === 0 && previous !== undefined && previous !== fragment.id) {
      reassembly.delete(previous)
      local.resetLocal(fragment.threadId)
    }
    latest.set(stream, fragment.id)
    const current = obtain(fragment)
    if (current.fragment.count !== fragment.count || current.fragment.threadId !== fragment.threadId)
      return reset(fragment)
    current.parts[fragment.index] = fragment.data
    projectComplete(current, fragment)
  }
}
