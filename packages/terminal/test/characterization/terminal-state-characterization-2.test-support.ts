import { expect, test } from "vitest"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Keys, ViewState } from "../../src/state/model/terminal-state"



export const key = (input: Partial<Keys.Key> & Pick<Keys.Key, "name">): Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

export const thread = (
  input: Partial<ViewState.ThreadItem> & Pick<ViewState.ThreadItem, "id" | "title">,
): ViewState.ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

export const readCall = (
  id: string,
  detail: string,
  status: "running" | "complete" = "running",
): Extract<ViewState.TranscriptBlock, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id,
  name: "read",
  input: detail,
  status,
  presentation: {
    family: "explore",
    action: "read",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "file",
  },
  detail,
  files: [],
})

export const editFile = (id: string, path: string) => ({
  key: id,
  path,
  kind: "update" as const,
  patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  preview: false,
  status: "complete" as const,
})

export const busyQueueModel = (model: ViewState.Model): ViewState.Model => ({
  ...model,
  busy: true,
  currentThreadId: "t",
})









































