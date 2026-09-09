/* oxlint-disable anti-slop/no-runtime-typeof -- Prompt's public union encodes string-or-parts content. */
/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- projection omits optional wire fields intentionally. */
/* oxlint-disable complexity -- preview fencing keeps identity, attempt, generation, sequence, and offset guards atomic. */
/* oxlint-disable effecttsgo/missing-pipeable-signature -- reducers consume state and event as one atomic pair. */
/* oxlint-disable typescript/no-unsafe-assignment -- map entries retain the typed PreviewProjection values. */
import type { Prompt } from "effect/unstable/ai"
import type {
  ConnectionEvent,
  ConnectionStatus,
  HostSessionSnapshot,
  ServerEvent,
} from "generalist/server"

export type ProjectionActivity = "idle" | "working" | "waiting" | "cancelled" | "failed"

export interface ProjectionItem {
  readonly id: string
  readonly kind: "user" | "assistant" | "reasoning" | "tool" | "child" | "notice" | "error" | "image"
  readonly title: string
  readonly text: string
  readonly status?: ProjectionActivity
  readonly language?: string
}

export interface ProjectionPendingTurn {
  readonly id: string
  readonly prompt: string
  readonly revision: number
  readonly images?: readonly { readonly mediaType: string; readonly fileName?: string }[]
}

export interface ProjectionThread {
  readonly id: string
  readonly title: string
  readonly target: "runner" | "orb"
  readonly activity: ProjectionActivity
  readonly items: readonly ProjectionItem[]
  readonly pending: readonly ProjectionPendingTurn[]
  readonly approval: null | { readonly id: string; readonly title: string; readonly detail: string }
  readonly activeRunId?: string
}

export interface PreviewProjection {
  readonly runId: string
  readonly attemptFence: number
  readonly modelCallId: string
  readonly modelAttemptId: string
  readonly attempt: number
  readonly generation: number
  readonly sequence: number
  readonly reasoning: string
  readonly text: string
  readonly cursor: number
}

export interface PreviewFence {
  readonly attemptFence: number
  readonly generation: number
  readonly modelCallId: string
  readonly modelAttemptId: string
}

export interface ProjectionState {
  readonly sessionId: string
  readonly snapshot: HostSessionSnapshot
  readonly thread: ProjectionThread
  readonly previews: ReadonlyMap<string, PreviewProjection>
  readonly previewFences: ReadonlyMap<string, PreviewFence>
  readonly connectionEpoch: number
  readonly committedCursor: number
  readonly needsSnapshot: boolean
}

export type ProjectionResult =
  | { readonly _tag: "Applied"; readonly state: ProjectionState }
  | { readonly _tag: "Ignored"; readonly state: ProjectionState }
  | { readonly _tag: "Rejected"; readonly state: ProjectionState; readonly reason: string }

const textOfPart = (part: Prompt.Part): string => {
  if (part.type === "text" || part.type === "reasoning") return part.text
  if (part.type === "file") return `[${part.fileName ?? part.mediaType}]`
  if (part.type === "tool-call") return `${part.name} ${JSON.stringify(part.params)}`
  if (part.type === "tool-result") return typeof part.result === "string" ? part.result : JSON.stringify(part.result)
  if (part.type === "tool-approval-request") return `Approval requested: ${part.toolCallId}`
  return `Approval response: ${part.approvalId}`
}

export const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (message.role === "system") return []
      if (typeof message.content === "string") return [message.content]
      return message.content.map(textOfPart)
    })
    .join("\n")

const itemStatus = (snapshot: HostSessionSnapshot, runId: string): ProjectionActivity => {
  const run = snapshot.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) return "working"
  if (run.status === "succeeded") return "idle"
  if (run.status === "failed") return "failed"
  if (run.status === "cancelled") return "cancelled"
  if (run.approval !== undefined) return "waiting"
  return "working"
}

const messageItem = (
  entryId: string,
  messageIndex: number,
  message: Exclude<Prompt.Message, { readonly role: "system" }>,
  status: ProjectionActivity,
): ProjectionItem[] => {
  if (typeof message.content === "string")
    return [{ id: `${entryId}:message:${messageIndex}`, kind: message.role, title: message.role, text: message.content, status }]
  return message.content.map((part, partIndex): ProjectionItem => {
    const id = `${entryId}:message:${messageIndex}:part:${partIndex}`
    if (part.type === "reasoning") return { id, kind: "reasoning", title: "Reasoning", text: part.text, status }
    if (part.type === "text") return { id, kind: message.role, title: message.role, text: part.text, status }
    if (part.type === "file")
      return { id, kind: "image", title: part.fileName ?? part.mediaType, text: part.mediaType, status }
    if (part.type === "tool-call") return { id, kind: "tool", title: part.name, text: textOfPart(part), status }
    if (part.type === "tool-result") return { id, kind: "tool", title: part.name, text: textOfPart(part), status }
    if (part.type === "tool-approval-request")
      return { id, kind: "tool", title: "Authorization required", text: textOfPart(part), status: "waiting" }
    return { id, kind: "tool", title: "Authorization", text: textOfPart(part), status }
  })
}

const itemsFromSnapshot = (
  snapshot: HostSessionSnapshot,
  previews: ReadonlyMap<string, PreviewProjection> = new Map(),
): readonly ProjectionItem[] => {
  const items: ProjectionItem[] = []
  for (const entry of snapshot.conversation.entries) {
    const status = itemStatus(snapshot, entry.id)
    for (const [messageIndex, message] of entry.messages.entries()) items.push(...messageItem(entry.id, messageIndex, message, status))
  }
  for (const run of snapshot.runs) {
    if (run.parentRunId === undefined) continue
    let status: ProjectionActivity = "working"
    if (run.status === "succeeded") status = "idle"
    else if (run.status === "failed") status = "failed"
    items.push({
      id: `child:${run.runId}`,
      kind: "child",
      title: run.runId,
      text: run.status,
      status,
    })
  }
  for (const preview of previews.values()) {
    if (preview.reasoning.length > 0)
      items.push({
        id: `preview:${preview.runId}:reasoning`,
        kind: "reasoning",
        title: "Reasoning preview",
        text: preview.reasoning,
        status: "working",
      })
    if (preview.text.length > 0)
      items.push({
        id: `preview:${preview.runId}:text`,
        kind: "assistant",
        title: "Rika preview",
        text: preview.text,
        status: "working",
      })
  }
  return items
}

const pendingFromSnapshot = (snapshot: HostSessionSnapshot): readonly ProjectionPendingTurn[] =>
  snapshot.session.queue.map((item) => ({
    id: item.id,
    prompt: promptText(item.prompt),
    revision: item.revision,
    images: item.prompt.content.flatMap((message) =>
      message.role === "user" && typeof message.content !== "string"
        ? message.content.flatMap((part) =>
            part.type === "file" ? [{ mediaType: part.mediaType, ...(part.fileName === undefined ? {} : { fileName: part.fileName }) }] : [],
          )
        : [],
    ),
  }))

const activityFromSnapshot = (snapshot: HostSessionSnapshot): ProjectionActivity => {
  if (snapshot.session.lifecycle === "closed" || snapshot.session.lifecycle === "stopped") return "cancelled"
  const active = snapshot.session.activeRunId
  return active === undefined ? "idle" : itemStatus(snapshot, active)
}

export const projectSnapshot = (input: {
  readonly sessionId: string
  readonly threadId?: string
  readonly snapshot: HostSessionSnapshot
  readonly target?: "runner" | "orb"
  readonly previousPreviews?: ReadonlyMap<string, PreviewProjection>
  readonly previousPreviewFences?: ReadonlyMap<string, PreviewFence>
}): ProjectionState => {
  const { sessionId, snapshot } = input
  const target = input.target ?? "runner"
  const previousPreviews = input.previousPreviews ?? new Map<string, PreviewProjection>()
  const previewFences = new Map(input.previousPreviewFences ?? new Map<string, PreviewFence>())
  if (input.previousPreviewFences === undefined) {
    for (const [runId, preview] of previousPreviews) {
      previewFences.set(runId, {
        attemptFence: preview.attemptFence,
        generation: preview.generation,
        modelCallId: preview.modelCallId,
        modelAttemptId: preview.modelAttemptId,
      })
    }
  }
  const thread: ProjectionThread = {
    id: input.threadId ?? sessionId,
    title: snapshot.session.title ?? `Thread ${sessionId}`,
    target,
    activity: activityFromSnapshot(snapshot),
    items: itemsFromSnapshot(snapshot, previousPreviews),
    pending: pendingFromSnapshot(snapshot),
    approval: null,
    ...(snapshot.session.activeRunId === undefined ? {} : { activeRunId: snapshot.session.activeRunId }),
  }
  return {
    sessionId,
    snapshot,
    thread,
    previews: previousPreviews,
    previewFences,
    connectionEpoch: 0,
    committedCursor: snapshot.cursor,
    needsSnapshot: false,
  }
}

const applyConversation = (
  snapshot: HostSessionSnapshot,
  update: Extract<ServerEvent, { readonly _tag: "Conversation" }>["update"],
): HostSessionSnapshot | undefined => {
  if (update.previousLeafId !== snapshot.conversation.leafId) return undefined
  const entries = update.reset === true
    ? [...update.entries]
    : [
        ...snapshot.conversation.entries.slice(
          0,
          update.afterEntryId === null
            ? 0
            : snapshot.conversation.entries.findIndex((entry) => entry.id === update.afterEntryId) + 1,
        ),
        ...update.entries,
      ]
  return {
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      leafId: update.leafId,
      entries,
      ...(update.nextLeafId === undefined ? {} : { nextLeafId: update.nextLeafId }),
    },
  }
}

const withSnapshot = (
  state: ProjectionState,
  snapshot: HostSessionSnapshot,
  previews = state.previews,
  previewFences = state.previewFences,
  connectionEpoch = state.connectionEpoch,
): ProjectionState => {
  const next = projectSnapshot({
    sessionId: state.sessionId,
    threadId: state.thread.id,
    snapshot,
    target: state.thread.target,
    previousPreviews: previews,
    previousPreviewFences: previewFences,
  })
  return { ...next, previewFences, connectionEpoch }
}

const previewEvent = (event: Extract<ServerEvent, { readonly _tag: "PreviewDelivery" }>): PreviewProjection => {
  const preview = event.event
  if (preview._tag === "ModelPreview") {
    const text = ""
    return {
      runId: event.runId,
      attemptFence: event.authorityAttemptFence,
      modelCallId: preview.modelCallId,
      modelAttemptId: preview.modelAttemptId,
      attempt: preview.attempt,
      generation: preview.generation,
      sequence: preview.sequence,
      reasoning: text,
      text,
      cursor: -1,
    }
  }
  return {
    runId: event.runId,
    attemptFence: event.authorityAttemptFence,
    modelCallId: "",
    modelAttemptId: "",
    attempt: 0,
    generation: preview.generation,
    sequence: -1,
    reasoning: "",
    text: "",
    cursor: -1,
  }
}

const applyPreview = (state: ProjectionState, event: Extract<ServerEvent, { readonly _tag: "PreviewDelivery" }>): ProjectionResult => {
  if (event.sessionId !== state.sessionId || event.runId !== event.event.runId)
    return { _tag: "Rejected", state, reason: "Preview belongs to another Session or Run" }
  const incoming = previewEvent(event)
  const current = state.previews.get(event.runId)
  const fence = state.previewFences.get(event.runId)
  const body = event.event
  if (body._tag === "ModelPreview") {
    if (fence !== undefined) {
      if (incoming.attemptFence < fence.attemptFence) return { _tag: "Ignored", state }
      if (incoming.attemptFence === fence.attemptFence && incoming.generation < fence.generation)
        return { _tag: "Ignored", state }
      if (
        incoming.attemptFence === fence.attemptFence &&
        incoming.generation === fence.generation &&
        (incoming.modelCallId !== fence.modelCallId || incoming.modelAttemptId !== fence.modelAttemptId)
      )
        return { _tag: "Ignored", state }
    }
    if (current !== undefined) {
      if (incoming.attemptFence < current.attemptFence) return { _tag: "Ignored", state }
      if (incoming.attemptFence === current.attemptFence && incoming.generation < current.generation) return { _tag: "Ignored", state }
      if (
        incoming.attemptFence === current.attemptFence &&
        incoming.generation === current.generation &&
        incoming.sequence <= current.sequence
      )
        return { _tag: "Ignored", state }
      if (incoming.modelCallId !== current.modelCallId || incoming.modelAttemptId !== current.modelAttemptId)
        return { _tag: "Ignored", state }
    }
    let reasoning = current?.reasoning ?? ""
    let text = current?.text ?? ""
    for (const change of body.changes) {
      const value = change.channel === "reasoning" ? reasoning : text
      if (change.offset > value.length) return { _tag: "Rejected", state, reason: "Preview offset exceeded current source" }
      const next = value.slice(0, change.offset) + change.delta
      if (change.channel === "reasoning") reasoning = next
      else text = next
    }
    const next = {
      ...incoming,
      reasoning,
      text,
      cursor: state.committedCursor,
    }
    const previews = new Map(state.previews)
    previews.set(event.runId, next)
    const previewFences = new Map(state.previewFences)
    previewFences.set(event.runId, {
      attemptFence: next.attemptFence,
      generation: next.generation,
      modelCallId: next.modelCallId,
      modelAttemptId: next.modelAttemptId,
    })
    return {
      _tag: "Applied",
      state: {
        ...state,
        previews,
        previewFences,
        thread: projectSnapshot({
          sessionId: state.sessionId,
          threadId: state.thread.id,
          snapshot: state.snapshot,
          target: state.thread.target,
          previousPreviews: previews,
          previousPreviewFences: previewFences,
        }).thread,
      },
    }
  }
  if (
    (fence !== undefined &&
      (incoming.attemptFence < fence.attemptFence ||
        (incoming.attemptFence === fence.attemptFence && incoming.generation < fence.generation))) ||
    (current !== undefined &&
      (incoming.attemptFence < current.attemptFence ||
        (incoming.attemptFence === current.attemptFence && incoming.generation < current.generation)))
  )
    return { _tag: "Ignored", state }
  const previews = new Map(state.previews)
  previews.delete(event.runId)
  return { _tag: "Applied", state: { ...state, previews } }
}

export const applyConnectionStatus = (state: ProjectionState, status: ConnectionStatus): ProjectionState => {
  if (status._tag === "Disconnected") return { ...state, thread: { ...state.thread, activity: "waiting" } }
  if (status._tag === "Retrying" || status._tag === "Connecting")
    return { ...state, thread: { ...state.thread, activity: "waiting" } }
  return { ...state, thread: { ...state.thread, activity: activityFromSnapshot(state.snapshot) } }
}

export const applyConnectionEvent = (state: ProjectionState, event: ConnectionEvent): ProjectionResult => {
  if (event._tag === "ConnectionSnapshot") {
    if (event.snapshot.session.id !== state.sessionId)
      return { _tag: "Rejected", state, reason: "Replacement snapshot belongs to another Session" }
    if (event.epoch < state.connectionEpoch) return { _tag: "Ignored", state }
    const next = projectSnapshot({
      sessionId: state.sessionId,
      threadId: state.thread.id,
      snapshot: event.snapshot,
      target: state.thread.target,
    })
    return { _tag: "Applied", state: { ...next, previewFences: state.previewFences, connectionEpoch: event.epoch } }
  }
  if (event._tag === "PreviewDelivery") return applyPreview(state, event)
  if (event.sessionId !== state.sessionId) return { _tag: "Rejected", state, reason: "Event belongs to another Session" }
  if (event.cursor <= state.committedCursor) return { _tag: "Ignored", state }
  if (event.cursor !== state.committedCursor + 1) return { _tag: "Rejected", state: { ...state, needsSnapshot: true }, reason: "Committed cursor is not contiguous" }
  let snapshot = state.snapshot
  if (event._tag === "Conversation") {
    const updated = applyConversation(snapshot, event.update)
    if (updated === undefined)
      return { _tag: "Rejected", state: { ...state, needsSnapshot: true }, reason: "Conversation leaf did not match" }
    snapshot = updated
  }
  snapshot = { ...snapshot, cursor: event.cursor }
  const previews = new Map(state.previews)
  if (event._tag === "Conversation" && event.update.entries.some((entry) => entry.messages.some((message) => message.role === "assistant"))) {
    for (const runId of previews.keys()) previews.delete(runId)
  }
  return { _tag: "Applied", state: withSnapshot({ ...state, snapshot, committedCursor: event.cursor }, snapshot, previews, state.previewFences) }
}
