import type { Effect } from "effect"

export type ScenarioId =
  | "welcome"
  | "conversation"
  | "streaming"
  | "approval"
  | "children"
  | "queue"
  | "error"
  | "reconnect"
  | "long"
export type Activity = "idle" | "working" | "waiting" | "cancelled" | "failed"
export type Mode = "low" | "medium" | "high" | "ultra"
export interface TranscriptItem {
  readonly id: string
  readonly kind: "user" | "assistant" | "reasoning" | "tool" | "diff" | "child" | "notice" | "error" | "image"
  readonly title: string
  readonly text: string
  readonly status?: Activity
  readonly language?: string
}
export interface ImageAttachment {
  readonly path: string
  readonly mediaType?: string
  readonly byteLength?: number
}
export interface PendingTurn {
  readonly id: string
  readonly prompt: string
  readonly images?: readonly ImageAttachment[]
}
export interface ThreadView {
  readonly id: string
  readonly title: string
  readonly target: "runner" | "orb"
  readonly activity: Activity
  readonly items: readonly TranscriptItem[]
  readonly pending: readonly PendingTurn[]
  readonly approval: { readonly id: string; readonly title: string; readonly detail: string } | null
}
export interface ClientState {
  readonly scenario: ScenarioId
  readonly selectedThreadId: string
  readonly threads: readonly ThreadView[]
  readonly mode: Mode
  readonly connection: "offline" | "connecting" | "connected" | "reconnecting" | "disconnected"
  readonly notice: string
}
export interface Client {
  readonly state: ClientState
  readonly loadScenario: (scenario: ScenarioId) => void
  readonly selectThread: (id: string) => void
  readonly newThread: (target?: "runner" | "orb") => void
  readonly archiveThread: () => void
  readonly submit: (prompt: string, images?: readonly ImageAttachment[]) => void
  readonly cancel: () => void
  readonly stop: () => void
  readonly followUp: (prompt: string, childSessionId?: string) => void
  readonly approve: (approved: boolean) => void
  readonly editPending: (id: string, prompt: string) => void
  readonly removePending: (id: string) => void
  readonly steerPending: (id: string) => void
  readonly interruptAndSend: (prompt: string, images?: readonly ImageAttachment[]) => void
  readonly setMode: (mode: Mode) => void
  readonly dispose: Effect.Effect<void>
}
export const scenarios: readonly { readonly id: ScenarioId; readonly title: string }[] = [
  { id: "welcome", title: "Welcome" },
  { id: "conversation", title: "Rich conversation" },
  { id: "streaming", title: "Streaming answer" },
  { id: "approval", title: "Authorization request" },
  { id: "children", title: "Parallel child runs" },
  { id: "queue", title: "Pending instructions" },
  { id: "error", title: "Execution failure" },
  { id: "reconnect", title: "Connection interrupted" },
  { id: "long", title: "Long transcript and diff" },
]
