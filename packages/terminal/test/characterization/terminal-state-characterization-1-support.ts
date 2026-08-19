import { Function } from "effect"
import { type Key } from "../../src/presentation/terminal/terminal-keymap"
import { type Model } from "../../src/state/model/terminal-state"
import { type ThreadItem } from "../../src/state/model/terminal-thread-state"
import { type TranscriptBlock } from "../../src/state/model/terminal-transcript-state"

export const key = (input: Partial<Key> & Pick<Key, "name">): Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

export const _thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

const readCallImpl = (
  id: string,
  detail: string,
  status: "running" | "complete" = "running",
): Extract<TranscriptBlock, { _tag: "ToolCall" }> => ({
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

export const readCall: {
  (
    arg0: Parameters<typeof readCallImpl>[0],
    arg1: Parameters<typeof readCallImpl>[1],
    arg2?: Parameters<typeof readCallImpl>[2],
  ): ReturnType<typeof readCallImpl>
  (
    arg1: Parameters<typeof readCallImpl>[1],
    arg2?: Parameters<typeof readCallImpl>[2],
  ): (arg0: Parameters<typeof readCallImpl>[0]) => ReturnType<typeof readCallImpl>
} = Function.dual((args) => args.length >= 2, readCallImpl)

const _editFileImpl = (id: string, path: string) => ({
  key: id,
  path,
  kind: "update" as const,
  patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  preview: false,
  status: "complete" as const,
})

export const _editFile: {
  (
    arg1: Parameters<typeof _editFileImpl>[1],
  ): (arg0: Parameters<typeof _editFileImpl>[0]) => ReturnType<typeof _editFileImpl>
  (
    arg0: Parameters<typeof _editFileImpl>[0],
    arg1: Parameters<typeof _editFileImpl>[1],
  ): ReturnType<typeof _editFileImpl>
} = Function.dual(2, _editFileImpl)

export const _busyQueueModel = (model: Model): Model => ({
  ...model,
  busy: true,
  currentThreadId: "t",
})
