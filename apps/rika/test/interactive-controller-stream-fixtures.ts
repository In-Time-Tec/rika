import { Function } from "effect"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as Turn from "@rika/product/turn-record"

import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"

import * as ViewState from "@rika/terminal/terminal-state"
import { unitDelta, visibleState } from "./interactive-controller-transcript-fixtures"

const projectionOriginImpl = (
  event: TranscriptSourceEvent.SourceEvent,
  executionId: string,
): Extract<
  Extract<InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
  { readonly _tag: "Event" }
> => {
  const blockId = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  const messageSequences = event.type === "steering.delivered" ? event.data?.message_sequences : undefined
  const steeringSequences = Array.isArray(messageSequences)
    ? messageSequences.filter((value): value is number => Number.isSafeInteger(value))
    : undefined
  return {
    _tag: "Event",
    executionId,
    cursor: event.cursor,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt,
    transient: TranscriptProjection.Fold.isTransientEvent(event),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(typeof blockId === "string" ? { blockId } : {}),
    ...(steeringSequences === undefined || steeringSequences.length === 0 ? {} : { steeringSequences }),
  }
}

export const projectionOrigin: {
  (event: TranscriptSourceEvent.SourceEvent, executionId: string): ReturnType<typeof projectionOriginImpl>
  (executionId: string): (event: TranscriptSourceEvent.SourceEvent) => ReturnType<typeof projectionOriginImpl>
} = Function.dual(2, projectionOriginImpl)

export const terminalRootStatus = (
  event: TranscriptSourceEvent.SourceEvent,
): "completed" | "failed" | "cancelled" | undefined => {
  if (event.type === "execution.completed") return "completed"
  if (event.type === "execution.failed") return "failed"
  if (event.type === "execution.cancelled") return "cancelled"
  return undefined
}

const transientDeltaImpl = (index: number, text: string): TranscriptSourceEvent.SourceEvent => ({
  cursor: `transient-${index}`,
  sequence: 2,
  type: "model.output.delta",
  createdAt: 3 + index,
  text,
  data: { delta: text, transient_index: index, model_call_id: "call-1", model_attempt_id: "attempt-1" },
})

export const transientDelta: {
  (index: number, text: string): ReturnType<typeof transientDeltaImpl>
  (text: string): (index: number) => ReturnType<typeof transientDeltaImpl>
} = Function.dual(2, transientDeltaImpl)

const startProjectionImpl = (
  state: InteractiveController.State,
  turn: Turn.Turn,
  projection: TranscriptProjectionModel.Projection,
) =>
  InteractiveController.update(state, {
    _tag: "TranscriptProjectionStarted",
    selectionEpoch: state.selectionEpoch,
    threadId: turn.threadId,
    rootTurnId: turn.id,
    turn,
    streamId: `stream:${turn.id}`,
    patchRevision: 0,
    state: visibleState(projection),
    units: projection.units,
  })

export const startProjection: {
  (
    state: InteractiveController.State,
    turn: Turn.Turn,
    projection: TranscriptProjectionModel.Projection,
  ): ReturnType<typeof startProjectionImpl>
  (
    turn: Turn.Turn,
    projection: TranscriptProjectionModel.Projection,
  ): (state: InteractiveController.State) => ReturnType<typeof startProjectionImpl>
} = Function.dual(3, startProjectionImpl)

const openProjectionStreamImpl = (state: InteractiveController.State, turnId: string) => {
  const stream = state.projectionStreams?.get(turnId)
  if (stream?._tag !== "Open") throw new Error(`Projection ${turnId} is not open`)
  return stream
}

export const openProjectionStream: {
  (state: InteractiveController.State, turnId: string): ReturnType<typeof openProjectionStreamImpl>
  (turnId: string): (state: InteractiveController.State) => ReturnType<typeof openProjectionStreamImpl>
} = Function.dual(2, openProjectionStreamImpl)

const makeProjectionFeedImpl = (
  selected: InteractiveController.State,
  turn: Turn.Turn,
  initialProjection: TranscriptProjectionModel.Projection,
) => {
  const streamId = `stream:${turn.id}`
  let state = startProjection(selected, turn, initialProjection).state
  let projection = initialProjection
  let patchRevision = 0
  return {
    get state() {
      return state
    },
    get projection() {
      return projection
    },
    apply(
      event: TranscriptSourceEvent.SourceEvent,
      options: { readonly executionId?: string; readonly projection?: TranscriptProjectionModel.Projection } = {},
    ) {
      const next = options.projection ?? TranscriptProjection.Projection.applyEvent(projection, event)
      const baseRevision = patchRevision
      patchRevision += 1
      const rootStatus = terminalRootStatus(event)
      const update = InteractiveController.update(state, {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: state.selectionEpoch,
        threadId: turn.threadId,
        rootTurnId: turn.id,
        streamId,
        baseRevision,
        patchRevision,
        origin: projectionOrigin(event, options.executionId ?? `execution:${turn.id}`),
        state: visibleState(next),
        delta: unitDelta(projection, next),
        ...(rootStatus === undefined ? {} : { rootStatus }),
      })
      state = update.state
      projection = next
      return update
    },
    stop(status: "completed" | "failed" | "cancelled") {
      const update = InteractiveController.update(state, {
        _tag: "TranscriptProjectionStopped",
        selectionEpoch: state.selectionEpoch,
        threadId: turn.threadId,
        rootTurnId: turn.id,
        streamId,
        patchRevision,
        status,
      })
      state = update.state
      return update
    },
  }
}

export const makeProjectionFeed: {
  (
    selected: InteractiveController.State,
    turn: Turn.Turn,
    initialProjection: TranscriptProjectionModel.Projection,
  ): ReturnType<typeof makeProjectionFeedImpl>
  (
    turn: Turn.Turn,
    initialProjection: TranscriptProjectionModel.Projection,
  ): (selected: InteractiveController.State) => ReturnType<typeof makeProjectionFeedImpl>
} = Function.dual(3, makeProjectionFeedImpl)

export const key = (input: Partial<ViewState.Keys.Key> & Pick<ViewState.Keys.Key, "name">): ViewState.Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})
