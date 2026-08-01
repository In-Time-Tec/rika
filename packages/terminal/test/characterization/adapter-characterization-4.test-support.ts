import { vi } from "vitest"

import { Effect } from "effect"
import { create, renderTranscriptStyled, type Handlers } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model, type ThreadItem } from "../../src/state/model/terminal-state"

export const shell = (id: string, command: string, output: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: JSON.stringify({ command }),
  output,
  status: "complete" as const,
  presentation: { family: "shell" as const, action: "command", activeLabel: "Running", completeLabel: "Ran" },
  detail: command,
  files: [],
})

export const _windowUnitToolCall = (id: string, family: "agent" | "explore") => ({
  _tag: "ToolCall" as const,
  id,
  name: family === "agent" ? "task" : "read",
  input: "{}",
  status: "complete" as const,
  presentation: {
    family,
    action: family === "agent" ? "task" : "read",
    activeLabel: family === "agent" ? "Exploring" : "Reading",
    completeLabel: family === "agent" ? "Explored" : "Read",
  },
  detail: id,
  files: [],
})

export const _agentToolBlock = (
  status: "running" | "complete" | "failed" | "cancelled",
  detail = "Investigate the crash",
) => ({
  _tag: "ToolCall" as const,
  id: "agent",
  name: "task",
  input: "{}",
  status,
  presentation: {
    family: "agent" as const,
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail,
  files: [],
})

export const handlers = (): Handlers => ({ key: vi.fn(), resize: vi.fn() })

export const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

export const subagentToolBlock = {
  _tag: "ToolCall" as const,
  id: "agent",
  name: "task",
  input: JSON.stringify({ prompt: "Inspect" }),
  status: "complete" as const,
  presentation: {
    family: "agent" as const,
    action: "task" as const,
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail: "Inspect",
  output: "done",
  files: [],
}

export const renderedText = (changes: Partial<Model>): string =>
  renderTranscriptStyled({ ...initial("/workspace", "medium"), ...changes })
    .chunks.map((chunk) => chunk.text)
    .join("")

export const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

export const _thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/workspace",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

export const createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))
