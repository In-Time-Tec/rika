import { vi } from "vitest"
import { Function, Effect } from "effect"
import { create } from "../../../src/opentui/surface/service"
import { type Handlers } from "../../../src/opentui/surface/state"
import { initial, type Model } from "../../../src/state/model"
import { type ThreadItem } from "../../../src/state/thread/model"

const shellImpl = (id: string, command: string, output: string) => ({
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

export const shell: {
  (
    arg1: Parameters<typeof shellImpl>[1],
    arg2: Parameters<typeof shellImpl>[2],
  ): (arg0: Parameters<typeof shellImpl>[0]) => ReturnType<typeof shellImpl>
  (
    arg0: Parameters<typeof shellImpl>[0],
    arg1: Parameters<typeof shellImpl>[1],
    arg2: Parameters<typeof shellImpl>[2],
  ): ReturnType<typeof shellImpl>
} = Function.dual(3, shellImpl)

const _windowUnitToolCallImpl = (id: string, family: "agent" | "explore") => ({
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

export const _windowUnitToolCall: {
  (
    arg1: Parameters<typeof _windowUnitToolCallImpl>[1],
  ): (arg0: Parameters<typeof _windowUnitToolCallImpl>[0]) => ReturnType<typeof _windowUnitToolCallImpl>
  (
    arg0: Parameters<typeof _windowUnitToolCallImpl>[0],
    arg1: Parameters<typeof _windowUnitToolCallImpl>[1],
  ): ReturnType<typeof _windowUnitToolCallImpl>
} = Function.dual(2, _windowUnitToolCallImpl)

const agentToolBlockImpl = (
  status: "running" | "complete" | "failed" | "cancelled",
  detail: string | undefined,
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
  detail: detail ?? "Investigate the crash",
  files: [],
})

export const agentToolBlock: {
  (detail: string | undefined): (status: Parameters<typeof agentToolBlockImpl>[0]) => ReturnType<typeof agentToolBlockImpl>
  (status: Parameters<typeof agentToolBlockImpl>[0], detail: string | undefined): ReturnType<typeof agentToolBlockImpl>
} = Function.dual(2, agentToolBlockImpl)

export const _handlers = (): Handlers => ({ key: vi.fn(), resize: vi.fn() })

export const _nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

export const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

export const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/workspace",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

export const _createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))
