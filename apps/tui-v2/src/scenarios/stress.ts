import { Effect } from "effect"
import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import type { Client } from "../client/model"
import type { StoreItem, StoreState } from "../client/state"

export interface WorkloadSize {
  readonly items: number
  readonly children: number
  readonly queued: number
  readonly threads: number
  readonly streams: number
  readonly streamPlacement?: "oldest" | "newest"
}

export const scales = {
  small: { items: 100, children: 10, queued: 10 },
  medium: { items: 1_000, children: 100, queued: 100 },
  large: { items: 10_000, children: 1_000, queued: 1_000 },
  extreme: { items: 100_000, children: 1_000, queued: 1_000 },
} as const

const historyItem = (index: number): StoreItem => {
  if (index % 6 === 4)
    return {
      id: `history-${index}`,
      kind: "assistant",
      title: "Rika",
      text: `Synthetic checkpoint ${index}: inspected the module and retained the public contract.`,
      status: "idle",
    }
  if (index % 6 === 5)
    return {
      id: `history-${index}`,
      kind: "user",
      title: "You",
      text: `Continue the synthetic inspection at checkpoint ${index}.`,
    }
  return {
    id: `history-${index}`,
    kind: "tool",
    title: index % 2 === 0 ? `Read src/module-${index}.ts` : "Run synthetic check",
    text:
      index % 2 === 0
        ? `src/module-${index}.ts\nexport const value = ${index}\n`
        : `$ bun test module-${index}\n3 passed, 0 failed\nexit code 0`,
    status: "idle",
  }
}

export function createWorkload(size: WorkloadSize) {
  const history = Array.from({ length: size.items }, (_, index) => historyItem(index))
  const toolIndices = history.flatMap((item, index) => (item.kind === "tool" ? [index] : []))
  const streamingTools =
    size.streamPlacement === "newest" ? toolIndices.slice(-size.streams) : toolIndices.slice(0, size.streams)
  const children: StoreItem[] = Array.from({ length: size.children }, (_, index) => ({
    id: `child-${index}`,
    kind: "child",
    title: `Synthetic subagent ${index}`,
    text: `Inspecting synthetic module ${index}`,
    status: "working",
  }))
  const [state, setState] = createStore<StoreState>({
    scenario: "streaming",
    selectedThreadId: "thread-0",
    mode: "medium",
    connection: "offline",
    notice: "Synthetic renderer benchmark: no agent execution or workspace access",
    threads: Array.from({ length: size.threads }, (_, index) => ({
      id: `thread-${index}`,
      title: `Synthetic thread ${index}`,
      target: "runner",
      activity: "working",
      approval: null,
      items: [
        ...(index === 0 ? [...history, ...children] : []),
        {
          id: `stream-${index}`,
          kind: "assistant",
          title: "Rika",
          text: "Synthetic streaming reply.",
          status: "working",
        },
      ],
      pending:
        index === 0
          ? Array.from({ length: size.queued }, (_value, pending) => ({
              id: `pending-${pending}`,
              prompt: `Synthetic queued instruction ${pending}: inspect the next module.`,
            }))
          : [],
    })),
  })
  const unsupported = () => {
    throw new Error("This benchmark only supports rendering, thread selection, and mode selection")
  }
  const client: Client = {
    state,
    loadScenario: unsupported,
    newThread: unsupported,
    archiveThread: unsupported,
    archiveAndNewThread: unsupported,
    submit: unsupported,
    cancel: unsupported,
    stop: unsupported,
    followUp: unsupported,
    approve: unsupported,
    editPending: unsupported,
    removePending: unsupported,
    steerPending: unsupported,
    interruptAndSend: unsupported,
    selectThread: (id) => setState("selectedThreadId", id),
    setMode: (mode) => setState("mode", mode),
    dispose: Effect.void,
  }
  const advance = (iteration: number) =>
    batch(() => {
      for (let index = 0; index < size.threads; index += 1) {
        const item = index === 0 ? size.items + size.children : 0
        setState("threads", index, "items", item, "text", (text) => `${text} chunk-${iteration}-${index}`)
      }
      for (let index = 0; index < Math.min(size.streams, size.children); index += 1) {
        setState(
          "threads",
          0,
          "items",
          size.items + index,
          "text",
          `Synthetic subagent ${index}: streamed checkpoint ${iteration}`,
        )
      }
      for (const index of streamingTools) {
        setState(
          "threads",
          0,
          "items",
          index,
          "text",
          (text) => `${text}\nSynthetic tool output checkpoint ${iteration}`,
        )
        setState("threads", 0, "items", index, "status", iteration % 2 === 0 ? "working" : "idle")
      }
      setState(
        "threads",
        0,
        "pending",
        size.queued - 1,
        "prompt",
        `Edited synthetic instruction at checkpoint ${iteration}`,
      )
      setState("threads", 0, "pending", (pending) => [
        ...pending.slice(1),
        { id: `pending-appended-${iteration}`, prompt: `Appended synthetic instruction ${iteration}` },
      ])
    })
  return {
    client,
    advance,
    streamingToolCount: streamingTools.length,
    toolCalls: history.filter((item) => item.kind === "tool").length,
  }
}
