import type { RunTree } from "@batonfx/runtime"
import * as Projection from "@rika/product/execution-projection"

export interface ToolState {
  readonly rawId: string
  readonly key: string
  readonly blockId: string
}

export interface Node {
  rawRunId: string
  readonly publicId: string
  readonly parentRawRunId?: string
  readonly parentUnitKey?: string
  readonly parentBlockId?: string
  readonly hidden: boolean
  readonly tools: Map<string, ToolState>
  phase: number
  status: "running" | "waiting" | "completed" | "failed" | "cancelled"
  lifecycle: "unknown" | "accepted" | "active" | "waiting" | "terminal"
  started: boolean
  attempt?: number
}

export interface Card {
  readonly parentRawRunId: string
  readonly rawInvocationId: string
  readonly publicId: string
  readonly unitKey: string
  readonly blockId: string
  readonly selection: string
  prompt: string
  promptTruncated: boolean
  readonly groupKey?: string
  rawChildRunId?: string
}

export interface Projector {
  readonly snapshot: () => Projection.Snapshot
  readonly apply: (input: RunTree.TreeEvent) => Projection.Patch
}
