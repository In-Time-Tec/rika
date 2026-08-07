import { Function, Data, Effect } from "effect"

import { initial, type Model } from "../../src/state/model/terminal-state"
import { type ThreadItem } from "../../src/state/model/terminal-thread-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"

export class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

export const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const _insertTextImpl = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

export const _insertText: {
  (
    arg1: Parameters<typeof _insertTextImpl>[1],
  ): (arg0: Parameters<typeof _insertTextImpl>[0]) => ReturnType<typeof _insertTextImpl>
  (
    arg0: Parameters<typeof _insertTextImpl>[0],
    arg1: Parameters<typeof _insertTextImpl>[1],
  ): ReturnType<typeof _insertTextImpl>
} = Function.dual(2, _insertTextImpl)

export const styledTextValue = (value: { readonly chunks: ReadonlyArray<{ readonly text: string }> } | string) =>
  typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")

const streamingShellImpl = (id: string, output?: string) => ({
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
  ...(output === undefined ? {} : { output }),
  files: [],
})

export const streamingShell: {
  (
    arg0: Parameters<typeof streamingShellImpl>[0],
    arg1?: Parameters<typeof streamingShellImpl>[1],
  ): ReturnType<typeof streamingShellImpl>
  (
    arg1?: Parameters<typeof streamingShellImpl>[1],
  ): (arg0: Parameters<typeof streamingShellImpl>[0]) => ReturnType<typeof streamingShellImpl>
} = Function.dual((args) => typeof args[0] === "string", streamingShellImpl)

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
    ...(index === 0 ? {} : { parentId: "root-tool" }),
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
      ...(index === 0 ? {} : { parentId: "root-tool" }),
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
