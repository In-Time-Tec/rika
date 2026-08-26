#!/usr/bin/env bun
import * as InteractiveEvent from "@rika/product/interactive-event"
import { Effect, Function } from "effect"

export const ignoreSelectionResync = (_threadId: string) => {}

const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()

const terminalTitleSequenceImpl = (title: string, workspace: string, workingFrame?: string): string => {
  const safeWorkingFrame = workingFrame === undefined ? "" : terminalTitleText(workingFrame)
  const prefix = safeWorkingFrame.length === 0 ? "" : `${safeWorkingFrame} `
  return `\u001b]0;${prefix}${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`
}

export const terminalTitleSequence: {
  (title: string, workspace: string, workingFrame?: string): string
  (workspace: string, workingFrame?: string): (title: string) => string
} = Function.dual((args) => args.length >= 2, terminalTitleSequenceImpl)

const traceTuiModelEventImpl = (seen: Set<string>, event: InteractiveEvent.InteractiveEvent) => {
  if (event._tag !== "ThreadViewPatch") return Effect.void
  const key = `${event.patch.threadId}:${event.patch.revision}`
  if (seen.has(key)) return Effect.void
  seen.add(key)
  return Effect.logInfo("tui.thread_view.patch_applied").pipe(
    Effect.annotateLogs({
      "rika.thread.id": String(event.patch.threadId),
      "rika.thread_view.revision": event.patch.revision,
    }),
  )
}

export const traceTuiModelEvent: {
  (event: InteractiveEvent.InteractiveEvent): (seen: Set<string>) => ReturnType<typeof traceTuiModelEventImpl>
  (seen: Set<string>, event: InteractiveEvent.InteractiveEvent): ReturnType<typeof traceTuiModelEventImpl>
} = Function.dual(2, traceTuiModelEventImpl)
