import {
  messages as transcriptMessages,
  type Block,
  type SemanticMessage,
  type SourceEvent,
  type Unit,
} from "@rika/transcript"
import { Function } from "effect"
import type { Message } from "./view-state"

export interface Event {
  readonly turnId?: string
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<unknown>
  readonly data?: Readonly<Record<string, unknown>>
}

const sourceEvent = (event: Event): SourceEvent => ({
  cursor: event.cursor,
  sequence: event.sequence,
  type: event.type,
  createdAt: event.sequence,
  ...(event.text === undefined ? {} : { text: event.text }),
  ...(event.content === undefined ? {} : { content: [...event.content] }),
  ...(event.data === undefined ? {} : { data: { ...event.data } }),
})

const viewMessage = (event: Event, message: SemanticMessage): Message => {
  const turn = event.turnId === undefined ? {} : { turnId: event.turnId }
  switch (message._tag) {
    case "AssistantStreamed":
    case "AssistantCompleted":
      return { ...message, ...turn }
    case "ExecutionCompleted":
    case "ExecutionCancelled":
      return { ...message, ...turn }
    case "ExecutionFailed":
      return { ...message, ...turn }
    case "UsageReported":
      return message
    case "ToolCallDeltaReceived":
      return message
    case "EventReplayed":
      return {
        _tag: "EventReplayed",
        event: { id: message.id, cursor: event.cursor, ...turn, block: message.block },
      }
  }
}

export const messages = (event: Event): ReadonlyArray<Message> =>
  transcriptMessages(event.turnId ?? "", sourceEvent(event)).map((message) => viewMessage(event, message))

export const project: {
  (events: ReadonlyArray<Event>): (model: import("./view-state").Model) => import("./view-state").Model
  (model: import("./view-state").Model, events: ReadonlyArray<Event>): import("./view-state").Model
} = Function.dual(2, (model: import("./view-state").Model, events: ReadonlyArray<Event>) => {
  let next = model
  const seen = new Set(next.seenExecutionEventKeys)
  let eventCursor = next.eventCursor
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    const key = `${event.turnId ?? ""}\u0000${event.cursor}`
    if (seen.has(key)) continue
    seen.add(key)
    eventCursor = event.cursor
    for (const message of messages(event)) next = importViewStateUpdate(next, message)
  }
  const keys = [...seen]
  return {
    ...next,
    seenExecutionEventKeys: keys.length > 2048 ? keys.slice(-2048) : keys,
    eventCursor,
  }
})

export const projectTurn: {
  (
    turnId: string,
    prompt: string,
    events: ReadonlyArray<Event>,
  ): (model: import("./view-state").Model) => import("./view-state").Model
  (
    model: import("./view-state").Model,
    turnId: string,
    prompt: string,
    events: ReadonlyArray<Event>,
  ): import("./view-state").Model
} = Function.dual(
  4,
  (model: import("./view-state").Model, turnId: string, prompt: string, events: ReadonlyArray<Event>) =>
    project(
      importViewStateUpdate(model, { _tag: "TurnStarted", turnId, prompt }),
      events.map((event) => ({ ...event, turnId })),
    ),
)

import { update as importViewStateUpdate } from "./view-state"

export const projectUnits: {
  (model: import("./view-state").Model, units: ReadonlyArray<Unit>): import("./view-state").Model
  (units: ReadonlyArray<Unit>): (model: import("./view-state").Model) => import("./view-state").Model
} = Function.dual(
  2,
  (model: import("./view-state").Model, units: ReadonlyArray<Unit>): import("./view-state").Model => {
    const entries = [...model.entries]
    const blocks = [...model.blocks] as Array<Block>
    const items = [...model.items] as Array<import("./view-state").TranscriptItem>
    const known = new Set(items.map((item) => item.id).filter((id): id is string => id !== undefined))
    for (const unit of units) {
      if (known.has(unit.key)) continue
      known.add(unit.key)
      if (unit.content._tag === "Entry") {
        entries.push({ ...unit.content, turnId: unit.turnId })
        items.push({ _tag: "Entry", index: entries.length - 1, id: unit.key, turnId: unit.turnId })
      } else {
        blocks.push(unit.content.block)
        items.push({ _tag: "Block", index: blocks.length - 1, id: unit.key, turnId: unit.turnId })
      }
    }
    return { ...model, entries, blocks, items }
  },
)
