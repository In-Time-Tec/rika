#!/usr/bin/env bun
import * as InteractiveEvent from "@rika/product/interactive-event"
import { Effect, Function } from "effect"

export const ignoreSelectionResync = (_threadId: string, _selectionEpoch: number) => {}

const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()

export const terminalTitleSequence: {
  (title: string, workspace: string, workingFrame?: string): string
  (workspace: string): (title: string) => string
} = Function.dual(
  (args) => args.length > 1,
  (title: string, workspace: string, workingFrame?: string): string => {
    const safeWorkingFrame = workingFrame === undefined ? "" : terminalTitleText(workingFrame)
    const prefix = safeWorkingFrame.length === 0 ? "" : `${safeWorkingFrame} `
    return `\u001b]0;${prefix}${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`
  },
)

const tuiTraceEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

export const traceTuiModelEvent = (seenDeltas: Set<string>, event: InteractiveEvent.InteractiveEvent) => {
  if (
    event._tag !== "TranscriptProjectionPatched" ||
    event.origin._tag !== "Event" ||
    !tuiTraceEventTypes.has(event.origin.type)
  )
    return Effect.void
  const delta = event.origin.type.endsWith(".delta")
  const key = `${event.rootTurnId}:${event.origin.executionId}:${event.origin.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo("tui.model.event_applied").pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.origin.cursor,
      "rika.event.type": event.origin.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.rootTurnId),
    }),
  )
}
