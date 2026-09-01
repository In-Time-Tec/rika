import * as Thread from "@rika/product/thread-record"
import { Function, Clock, Effect, Queue, Ref, Semaphore } from "effect"
import type { InteractiveEvent, InteractiveEvent as RuntimeEvent } from "../session-event"
import type { InteractiveEvent as ClientEvent } from "../event"
import * as InteractiveThreadView from "./thread"
import { OperationUnavailable } from "../../contract/product"

export const capacity = 64

export interface State {
  readonly transcriptThreadIds: Set<string>
  readonly queueThreadIds: Set<string>
  readonly critical: Array<InteractiveEvent>
  readonly settlements: Map<string, Extract<InteractiveEvent, { readonly _tag: "TurnSettled" }>>
  readonly refolds: Map<string, Extract<InteractiveEvent, { readonly _tag: "ThreadRefolding" }>>
  readonly previewInvalidations: Map<
    string,
    Extract<InteractiveEvent, { readonly _tag: "ExecutionModelPreviewChanged" }>
  >
  criticalOverflowed: boolean
  activated?: Extract<InteractiveEvent, { readonly _tag: "ThreadActivated" }>
  summaries?: Extract<InteractiveEvent, { readonly _tag: "ThreadsListed" }>
}

export const make = (): State => ({
  transcriptThreadIds: new Set(),
  queueThreadIds: new Set(),
  critical: [],
  settlements: new Map(),
  refolds: new Map(),
  previewInvalidations: new Map(),
  criticalOverflowed: false,
})

const overflowEventThreadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

const rememberThread = (state: State, threadIds: Set<string>, id: string) => {
  if (threadIds.has(id)) return
  if (threadIds.size >= capacity) {
    state.criticalOverflowed = true
    return
  }
  threadIds.add(id)
}

const criticalTags: ReadonlySet<InteractiveEvent["_tag"]> = new Set([
  "AssistantCompleted",
  "ContextDiagnostics",
  "ExecutionControlFailed",
  "ExecutionFailed",
  "SubmissionRejected",
  "QueueFull",
  "ShellCompleted",
  "ExecutionControlled",
  "ThreadTitled",
  "ThreadPreviewLoaded",
  "ThreadPreviewFailed",
  "TurnSettled",
])
const transcriptTags: ReadonlySet<InteractiveEvent["_tag"]> = new Set([
  "ExecutionProjectionChanged",
  "ExecutionProjectionResyncRequired",
  "TurnStarted",
  "SelectionLoaded",
])
const queueTags: ReadonlySet<InteractiveEvent["_tag"]> = new Set(["QueueUpdated", "ThreadViewResyncRequired"])

export const isCritical = (event: InteractiveEvent): boolean => criticalTags.has(event._tag)

const rememberPreview = (
  state: State,
  event: Extract<InteractiveEvent, { readonly _tag: "ExecutionModelPreviewChanged" }>,
) => {
  if (event.preview._tag === "ModelPreviewUsage") return
  const key = `${event.threadId}:${event.turnId}:${event.preview.runId}`
  if (!state.previewInvalidations.has(key) && state.previewInvalidations.size >= capacity) {
    state.criticalOverflowed = true
    return
  }
  const preview: Extract<ClientEvent, { readonly _tag: "ExecutionModelPreviewChanged" }>["preview"] = {
    _tag: "ModelPreviewCleared",
    runId: event.preview.runId,
    attemptFence: event.preview.attemptFence,
    generation: event.preview._tag === "ModelPreviewCleared" ? event.preview.generation : 0,
  }
  state.previewInvalidations.set(key, {
    ...event,
    preview: event.preview.parentId === undefined ? preview : { ...preview, parentId: event.preview.parentId },
  })
}

const rememberCritical = (state: State, event: InteractiveEvent) => {
  if (state.critical.length >= capacity) state.criticalOverflowed = true
  else state.critical.push(event)
}

const rememberImpl = (state: State, event: InteractiveEvent) => {
  if (event._tag === "TurnSettled") {
    const key = `${event.threadId}:${event.turnId}`
    const previous = state.settlements.get(key)
    if (previous === undefined || previous.activitySequence < event.activitySequence) state.settlements.set(key, event)
    return
  }
  if (state.criticalOverflowed) return
  if (isCritical(event)) {
    rememberCritical(state, event)
    return
  }
  const id = overflowEventThreadId(event)
  if (transcriptTags.has(event._tag)) {
    if (id !== undefined) rememberThread(state, state.transcriptThreadIds, id)
    return
  }
  if (queueTags.has(event._tag)) {
    if (id !== undefined) rememberThread(state, state.queueThreadIds, id)
    return
  }
  switch (event._tag) {
    case "ExecutionModelPreviewChanged":
      rememberPreview(state, event)
      return
    case "ThreadActivated":
      state.activated = event
      break
    case "ThreadsListed":
      state.summaries = event
      return
    case "ThreadRefolding":
      if (id !== undefined) state.refolds.set(id, event)
  }
}

export const remember: {
  (event: InteractiveEvent): (state: State) => void
  (state: State, event: InteractiveEvent): void
} = Function.dual(2, rememberImpl)

const eventsImpl = (state: State, selectionEpoch: number, reason: string): ReadonlyArray<InteractiveEvent> => {
  const recovered: Array<InteractiveEvent> = []
  if (state.activated !== undefined) recovered.push(state.activated)
  if (state.summaries !== undefined) recovered.push(state.summaries)
  recovered.push(...state.critical)
  recovered.push(
    ...[...state.settlements.values()].toSorted((left, right) => left.activitySequence - right.activitySequence),
  )
  recovered.push(...state.refolds.values())
  recovered.push(...state.previewInvalidations.values())
  for (const id of state.transcriptThreadIds)
    recovered.push({
      _tag: "ExecutionProjectionResyncRequired",
      threadId: Thread.ThreadId.make(id),
    })
  for (const id of state.queueThreadIds)
    recovered.push({
      _tag: "ThreadViewResyncRequired",
      selectionEpoch,
      threadId: Thread.ThreadId.make(id),
      reason,
    })
  return recovered
}

export const events: {
  (selectionEpoch: number, reason: string): (state: State) => ReadonlyArray<InteractiveEvent>
  (state: State, selectionEpoch: number, reason: string): ReadonlyArray<InteractiveEvent>
} = Function.dual(3, eventsImpl)

const withEpoch = (event: RuntimeEvent, epoch: number): RuntimeEvent => {
  switch (event._tag) {
    case "SelectionLoaded":
    case "QueueUpdated":
    case "ThreadViewResyncRequired":
    case "QueueFull":
    case "TurnStarted":
    case "TurnSettled":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "SubmissionRejected":
    case "ExecutionControlFailed":
    case "ExecutionControlled":
      return { ...event, selectionEpoch: epoch }
    default:
      return event
  }
}

interface SessionEnvelope {
  readonly event: RuntimeEvent
  readonly selectionRequest?: number
  readonly selectedThreadOnly?: boolean
}

export interface SelectionLoad {
  readonly epoch: number
  readonly threadId: string
  readonly previousEpoch: number
  readonly previousThreadId: string | undefined
  readonly events: Array<RuntimeEvent>
  committed: boolean
  overflow?: State
}

export interface InteractiveOperationFeed {
  readonly sessionDispatch: (event: RuntimeEvent) => void
  readonly selectionDispatch: (request: number) => (event: RuntimeEvent) => void
  readonly beginSelection: (
    epoch: number,
    threadId: string,
    previousEpoch: number,
    previousThreadId: string | undefined,
  ) => void
  readonly joinInitialSelection: (threadId: string) => boolean
  readonly commitSelection: (epoch: number) => boolean
  readonly finishSelection: (epoch: number) => Effect.Effect<void>
  readonly releaseSelectionEvents: (epoch: number, reason: string) => void
  readonly events: (
    dispatch: (event: ClientEvent) => void,
    currentEpoch: () => number,
    selectedThread: () => string | undefined,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly currentView: () => import("@rika/product/thread-view").ThreadViewSnapshot | undefined
  readonly projectionCheckpoint: (turnId: string) => import("@rika/product/execution-projection").Checkpoint | undefined
  readonly emit: (dispatch: (event: RuntimeEvent) => void, event: RuntimeEvent) => void
  readonly close: Effect.Effect<void>
  readonly eventThreadId: (event: RuntimeEvent) => string | undefined
  readonly bufferSelectionEvent: (event: RuntimeEvent) => boolean
  readonly deliver: (
    event: RuntimeEvent,
    options?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
  ) => boolean
}

const runtimeEventThreadId = (event: RuntimeEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

export const makeInteractiveOperationFeed = (input: {
  readonly sessionId: number
  readonly sessionScope: import("effect").Scope.Scope
  readonly publishActivity: (origin: number, event: RuntimeEvent) => RuntimeEvent
  readonly selectionAdmission: Semaphore.Semaphore
  readonly selectionRequest: import("effect").Ref.Ref<number>
  readonly selectionLoad: {
    readonly get: () => SelectionLoad | undefined
    readonly set: (value: SelectionLoad | undefined) => void
  }
  readonly currentEpoch: () => number
}): Effect.Effect<InteractiveOperationFeed> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<SessionEnvelope>(64)
    const clock = yield* Clock.Clock
    const threadViews = InteractiveThreadView.makeThreadViewFeed(() => clock.currentTimeMillisUnsafe())
    let overflow: State | undefined

    const deliver = (
      event: RuntimeEvent,
      options?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
    ): boolean => {
      const selected = withEpoch(event, options?.selectionRequest ?? input.currentEpoch())
      let envelope: SessionEnvelope = { event: selected }
      if (options?.selectionRequest !== undefined)
        envelope = { ...envelope, selectionRequest: options.selectionRequest }
      if (options?.selectedThreadOnly !== undefined)
        envelope = { ...envelope, selectedThreadOnly: options.selectedThreadOnly }
      if (overflow !== undefined) {
        remember(overflow, selected)
        return false
      }
      if (Queue.offerUnsafe(queue, envelope)) return true
      overflow = make()
      remember(overflow, selected)
      return false
    }

    const bufferSelectionEvent = (event: RuntimeEvent): boolean => {
      const loading = input.selectionLoad.get()
      if (loading === undefined || runtimeEventThreadId(event) !== loading.threadId) return false
      const selected = withEpoch(event, loading.epoch)
      if (loading.overflow !== undefined) {
        remember(loading.overflow, selected)
        return true
      }
      if (loading.events.length < 64) {
        loading.events.push(selected)
        return true
      }
      loading.overflow = make()
      for (const buffered of loading.events) remember(loading.overflow, buffered)
      loading.events.length = 0
      remember(loading.overflow, selected)
      return true
    }

    const sessionDispatch = (event: RuntimeEvent) => {
      if (!bufferSelectionEvent(event)) deliver(event)
    }
    const selectionDispatch = (request: number) => (event: RuntimeEvent) =>
      deliver(event, { selectionRequest: request })
    const releaseSelectionEvents = (epoch: number, reason: string) => {
      const loading = input.selectionLoad.get()
      if (loading === undefined) return
      if (loading.overflow === undefined) {
        for (const event of loading.events) deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
        return
      }
      for (const event of events(loading.overflow, epoch, reason))
        deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
    }
    const finishSelection = (epoch: number) =>
      input.selectionAdmission.withPermits(1)(
        Effect.gen(function* () {
          const loading = input.selectionLoad.get()
          if (loading === undefined || loading.epoch !== epoch || loading.committed) return
          input.selectionLoad.set(undefined)
          const restored = yield* Ref.modify(input.selectionRequest, (current) =>
            current === epoch ? [true, loading.previousEpoch] : [false, current],
          )
          if (restored && loading.previousThreadId === loading.threadId)
            releaseSelectionEvents(loading.previousEpoch, "Reload activity exceeded its bounded live window")
        }),
      )

    const commitSelection = (epoch: number): boolean => {
      const loading = input.selectionLoad.get()
      if (loading === undefined || loading.epoch !== epoch) return false
      loading.committed = true
      releaseSelectionEvents(epoch, "Selection activity exceeded its bounded live window")
      input.selectionLoad.set(undefined)
      return true
    }

    const beginSelection = (
      epoch: number,
      threadId: string,
      previousEpoch: number,
      previousThreadId: string | undefined,
    ) => {
      input.selectionLoad.set({ epoch, threadId, previousEpoch, previousThreadId, events: [], committed: false })
    }
    const joinInitialSelection = (threadId: string): boolean => {
      const loading = input.selectionLoad.get()
      if (loading?.epoch !== 0 || loading.threadId !== threadId) return false
      return true
    }
    const emit = (dispatch: (event: RuntimeEvent) => void, event: RuntimeEvent) => {
      const published = input.publishActivity(input.sessionId, event)
      dispatch(published)
    }
    const feedEvents = (
      dispatch: (event: ClientEvent) => void,
      readEpoch: () => number,
      readThread: () => string | undefined,
    ) => {
      const publish = (event: RuntimeEvent) => {
        for (const value of threadViews.publish(event)) dispatch(value)
      }
      return Effect.gen(function* () {
        while (true) {
          if (overflow !== undefined) {
            const state = overflow
            for (const discarded of yield* Queue.takeAll(queue)) remember(state, discarded.event)
            overflow = undefined
            if (state.criticalOverflowed)
              return yield* OperationUnavailable.make({
                operation: "InteractiveSession.events",
                message: "Interactive event feed exceeded its bounded non-recoverable event capacity",
              })
            for (const event of events(state, readEpoch(), "Interactive event feed exceeded its bounded live window"))
              publish(event)
            continue
          }
          const envelope = yield* Queue.take(queue)
          if (overflow !== undefined) {
            remember(overflow, envelope.event)
            continue
          }
          if (envelope.selectionRequest !== undefined && envelope.selectionRequest !== readEpoch()) continue
          if (envelope.selectedThreadOnly === true) {
            const envelopeThreadId = runtimeEventThreadId(envelope.event)
            if (envelopeThreadId !== undefined && envelopeThreadId !== readThread()) continue
          }
          publish(envelope.event)
        }
      })
    }
    return {
      sessionDispatch,
      selectionDispatch,
      beginSelection,
      joinInitialSelection,
      commitSelection,
      finishSelection,
      releaseSelectionEvents,
      events: feedEvents,
      currentView: threadViews.current,
      projectionCheckpoint: threadViews.checkpoint,
      emit,
      close: Queue.shutdown(queue),
      eventThreadId: runtimeEventThreadId,
      bufferSelectionEvent,
      deliver,
    }
  })
