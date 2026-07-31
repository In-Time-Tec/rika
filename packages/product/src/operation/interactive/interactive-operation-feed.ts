import { Effect, Queue, Ref, Semaphore } from "effect"
import * as InteractiveFeedOverflow from "./interactive-feed-overflow"
import type { InteractiveEvent } from "./interactive-event"
import { OperationUnavailable } from "../contract/product-operation-service"

const withEpoch = (event: InteractiveEvent, epoch: number): InteractiveEvent => {
  switch (event._tag) {
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "TranscriptPageAppended":
    case "TranscriptProjectionStarted":
    case "TranscriptProjectionPatched":
    case "TranscriptProjectionStopped":
    case "TranscriptProjectionFailed":
    case "TranscriptResyncRequired":
    case "QueueUpdated":
    case "QueueResyncRequired":
    case "QueueFull":
    case "TurnStarted":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "ExecutionControlFailed":
    case "ExecutionControlled":
    case "ThreadUsageUpdated":
      return { ...event, selectionEpoch: epoch }
    default:
      return event
  }
}

interface SessionEnvelope {
  readonly event: InteractiveEvent
  readonly selectionRequest?: number
  readonly selectedThreadOnly?: boolean
}

export interface SelectionLoad {
  readonly epoch: number
  readonly threadId: string
  readonly previousEpoch: number
  readonly previousThreadId: string | undefined
  readonly events: Array<InteractiveEvent>
  committed: boolean
  overflow?: InteractiveFeedOverflow.State
}

export interface InteractiveOperationFeed {
  readonly sessionDispatch: (event: InteractiveEvent) => void
  readonly selectionDispatch: (request: number) => (event: InteractiveEvent) => void
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
    dispatch: (event: InteractiveEvent) => void,
    currentEpoch: () => number,
    selectedThread: () => string | undefined,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly close: Effect.Effect<void>
  readonly eventThreadId: (event: InteractiveEvent) => string | undefined
  readonly bufferSelectionEvent: (event: InteractiveEvent) => boolean
  readonly deliver: (
    event: InteractiveEvent,
    options?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
  ) => boolean
}

const eventThreadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

export const makeInteractiveOperationFeed = (input: {
  readonly sessionId: number
  readonly sessionScope: import("effect").Scope.Scope
  readonly publishActivity: (origin: number, event: InteractiveEvent) => void
  readonly selectionAdmission: Semaphore.Semaphore
  readonly selectionRequest: import("effect").Ref.Ref<number>
  readonly selectionLoad: {
    readonly get: () => SelectionLoad | undefined
    readonly set: (value: SelectionLoad | undefined) => void
  }
  readonly currentEpoch: () => number
}): Effect.Effect<InteractiveOperationFeed> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<SessionEnvelope>(8192)
    let overflow: InteractiveFeedOverflow.State | undefined

    const deliver = (
      event: InteractiveEvent,
      options?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
    ): boolean => {
      const selected = withEpoch(event, options?.selectionRequest ?? input.currentEpoch())
      const envelope: SessionEnvelope = {
        event: selected,
        ...(options?.selectionRequest === undefined ? {} : { selectionRequest: options.selectionRequest }),
        ...(options?.selectedThreadOnly === undefined ? {} : { selectedThreadOnly: options.selectedThreadOnly }),
      }
      if (overflow !== undefined) {
        InteractiveFeedOverflow.remember(overflow, selected)
        return false
      }
      if (Queue.offerUnsafe(queue, envelope)) return true
      overflow = InteractiveFeedOverflow.make()
      InteractiveFeedOverflow.remember(overflow, selected)
      return false
    }

    const bufferSelectionEvent = (event: InteractiveEvent): boolean => {
      const loading = input.selectionLoad.get()
      if (loading === undefined || eventThreadId(event) !== loading.threadId) return false
      const selected = withEpoch(event, loading.epoch)
      if (loading.overflow !== undefined) {
        InteractiveFeedOverflow.remember(loading.overflow, selected)
        return true
      }
      if (loading.events.length < 8192) {
        loading.events.push(selected)
        return true
      }
      loading.overflow = InteractiveFeedOverflow.make()
      for (const buffered of loading.events) InteractiveFeedOverflow.remember(loading.overflow, buffered)
      loading.events.length = 0
      InteractiveFeedOverflow.remember(loading.overflow, selected)
      return true
    }

    const sessionDispatch = (event: InteractiveEvent) => {
      if (!bufferSelectionEvent(event)) deliver(event)
    }
    const selectionDispatch = (request: number) => (event: InteractiveEvent) =>
      deliver(event, { selectionRequest: request })
    const releaseSelectionEvents = (epoch: number, reason: string) => {
      const loading = input.selectionLoad.get()
      if (loading === undefined) return
      if (loading.overflow === undefined) {
        for (const event of loading.events) deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
        return
      }
      for (const event of InteractiveFeedOverflow.events(loading.overflow, epoch, reason))
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
    const emit = (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => {
      dispatch(event)
      input.publishActivity(input.sessionId, event)
    }
    const events = (
      dispatch: (event: InteractiveEvent) => void,
      readEpoch: () => number,
      readThread: () => string | undefined,
    ) =>
      Effect.gen(function* () {
        while (true) {
          if (overflow !== undefined) {
            const state = overflow
            for (const discarded of yield* Queue.takeAll(queue))
              InteractiveFeedOverflow.remember(state, discarded.event)
            overflow = undefined
            if (state.criticalOverflowed)
              return yield* OperationUnavailable.make({
                operation: "InteractiveSession.events",
                message: "Interactive event feed exceeded its bounded non-recoverable event capacity",
              })
            for (const event of InteractiveFeedOverflow.events(
              state,
              readEpoch(),
              "Interactive event feed exceeded its bounded live window",
            ))
              dispatch(event)
            continue
          }
          const envelope = yield* Queue.take(queue)
          if (overflow !== undefined) {
            InteractiveFeedOverflow.remember(overflow, envelope.event)
            continue
          }
          if (envelope.selectionRequest !== undefined && envelope.selectionRequest !== readEpoch()) continue
          if (envelope.selectedThreadOnly === true) {
            const threadId = eventThreadId(envelope.event)
            if (threadId !== undefined && threadId !== readThread()) continue
          }
          dispatch(envelope.event)
        }
      })
    return {
      sessionDispatch,
      selectionDispatch,
      beginSelection,
      joinInitialSelection,
      commitSelection,
      finishSelection,
      releaseSelectionEvents,
      events,
      emit,
      close: Queue.shutdown(queue),
      eventThreadId,
      bufferSelectionEvent,
      deliver,
    }
  })
