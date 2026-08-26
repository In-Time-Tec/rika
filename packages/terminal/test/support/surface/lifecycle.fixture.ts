import { vi } from "vitest"
import { Effect } from "effect"
import { create } from "../../../src/opentui/surface/service"
import { renderTranscriptStyled } from "../../../src/opentui/rendering/renderer"
import { type Handlers } from "../../../src/opentui/surface/state"
import { initial, type Model } from "../../../src/state/model"
import { type ThreadItem } from "../../../src/state/thread/model"

const shell = (id: string, command: string, output: string) => ({
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

const _handlers = (): Handlers => ({ key: vi.fn(), resize: vi.fn() })

const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

const subagentToolBlock = {
  _tag: "ToolCall" as const,
  id: "agent",
  name: "task",
  input: JSON.stringify({ prompt: "Inspect the repository" }),
  status: "complete" as const,
  presentation: {
    family: "agent" as const,
    action: "task" as const,
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail: "Inspect the repository",
  output: "Inspect complete",
  files: [],
}

const editToolBlock = {
  _tag: "ToolCall" as const,
  id: "patch",
  name: "edit",
  input: JSON.stringify({ path: "src/a.ts", patch: "@@\n-old\n+new" }),
  status: "complete" as const,
  presentation: {
    family: "edit" as const,
    action: "edit" as const,
    activeLabel: "Editing",
    completeLabel: "Edited",
  },
  detail: "src/a.ts",
  output: "@@\n-old\n+new",
  patch: "@@\n-old\n+new",
  files: [
    {
      key: "patch:0",
      path: "src/a.ts",
      kind: "update" as const,
      patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new",
      additions: 1,
      deletions: 1,
      preview: true,
      status: "complete" as const,
    },
  ],
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

const _createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))

export const adapterFixtures3 = {
  shell,
  _windowUnitToolCall,
  _agentToolBlock,
  _handlers,
  nonEmptyLines,
  subagentToolBlock,
  editToolBlock,
  renderedText,
  model,
  _thread,
  _createScoped,
}
