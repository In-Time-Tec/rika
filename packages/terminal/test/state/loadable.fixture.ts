import { vi } from "vitest"

import { Effect } from "effect"
import { create } from "../../src/opentui/surface/service"
import { renderTranscriptStyled } from "../../src/opentui/rendering/renderer"
import { type Handlers } from "../../src/opentui/surface/state"
import { initial, type Model } from "../../src/state/model"
import { type ThreadItem } from "../../src/state/thread/model"

const shell = (id: string, command: string, output: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: JSON.stringify({ command }),
  result: { text: output },
  status: "complete" as const,
  presentation: { family: "shell" as const, action: "command", activeLabel: "Running", completeLabel: "Ran" },
  detail: command,
  files: [],
})

const _windowUnitToolCall = (id: string, family: "agent" | "explore") => ({
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

const _agentToolBlock = (
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

const handlers = (): Handlers => ({ key: vi.fn(), resize: vi.fn() })

const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

const subagentToolBlock = {
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
  result: { text: "done" },
  files: [],
}

const renderedText = (changes: Partial<Model>): string =>
  renderTranscriptStyled({ ...initial("/workspace", "medium"), ...changes })
    .chunks.map((chunk) => chunk.text)
    .join("")

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

const _thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/workspace",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

const createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))

export const adapterFixtures4 = {
  shell,
  _windowUnitToolCall,
  _agentToolBlock,
  handlers,
  nonEmptyLines,
  subagentToolBlock,
  renderedText,
  model,
  _thread,
  createScoped,
}
