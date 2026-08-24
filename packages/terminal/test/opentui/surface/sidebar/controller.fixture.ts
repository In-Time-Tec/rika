import { StyledText } from "@opentui/core"
import { Function, Data, Effect } from "effect"

import { initial, type Model } from "../../../../src/state/model"
import { type ThreadItem } from "../../../../src/state/thread/model"
import { update } from "../../../../src/state/reducer/model"

export class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

export const openTui = <A>(operation: () => ReturnType<typeof Promise.resolve<A>>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const insertTextImpl = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

export const insertText: {
  (
    arg1: Parameters<typeof insertTextImpl>[1],
  ): (arg0: Parameters<typeof insertTextImpl>[0]) => ReturnType<typeof insertTextImpl>
  (
    arg0: Parameters<typeof insertTextImpl>[0],
    arg1: Parameters<typeof insertTextImpl>[1],
  ): ReturnType<typeof insertTextImpl>
} = Function.dual(2, insertTextImpl)

export const styledTextValue = (value: StyledText | string) =>
  value instanceof StyledText ? value.chunks.map((chunk) => chunk.text).join("") : value

const streamingShellImpl = (id: string, output: string | undefined) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: `{"command":"printf ${id}"}`,
  status: "running" as const,
  presentation: {
    family: "shell" as const,
    action: "shell",
    activeLabel: "Running",
    completeLabel: "Ran",
  },
  detail: `printf ${id}`,
  output,
  files: [],
})
export const _streamingShell: {
  (output: string | undefined): (id: string) => ReturnType<typeof streamingShellImpl>
  (id: string, output: string | undefined): ReturnType<typeof streamingShellImpl>
} = Function.dual(2, streamingShellImpl)

export const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

export const _giantSubagentModel = (childCount: number): Model => {
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = blocks.map((block, index) => ({
    _tag: "Block" as const,
    index,
    id: `block-${block.id}`,
    turnId: "turn-1",
    parentId: index === 0 ? undefined : "root-tool",
  }))
  return {
    ...initial("/work", "high"),
    blocks,
    items,
    expandedRowKeys: ["tool:root-tool"],
    scrollFollow: false,
  }
}

const _collapsedSubagentModelImpl = (answerCount: number, childCount: number): Model => {
  const entries = Array.from({ length: answerCount }, (_, index) => ({
    role: "assistant" as const,
    text: `answer ${index}`,
    turnId: "turn-1",
  }))
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "running" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = [
    ...entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `answer-${index}`,
      turnId: "turn-1",
    })),
    ...blocks.map((block, index) => ({
      _tag: "Block" as const,
      index,
      id: `block-${block.id}`,
      turnId: "turn-1",
      parentId: index === 0 ? undefined : "root-tool",
    })),
  ]
  return {
    ...initial("/work", "high"),
    entries,
    blocks,
    items,
    expandedRowKeys: [],
    scrollFollow: true,
  }
}

export const _collapsedSubagentModel: {
  (
    arg1: Parameters<typeof _collapsedSubagentModelImpl>[1],
  ): (arg0: Parameters<typeof _collapsedSubagentModelImpl>[0]) => ReturnType<typeof _collapsedSubagentModelImpl>
  (
    arg0: Parameters<typeof _collapsedSubagentModelImpl>[0],
    arg1: Parameters<typeof _collapsedSubagentModelImpl>[1],
  ): ReturnType<typeof _collapsedSubagentModelImpl>
} = Function.dual(2, _collapsedSubagentModelImpl)
