import * as Projection from "@rika/product/execution-projection"
import type { Card, CellState, Node, ToolState } from "./baton-projector-model"

export interface AuthorizationState {
  readonly unitKey: string
  readonly rawRunId: string
  readonly authorizationId: string
  readonly approvalId: string
}

export type PersistedCard = Omit<Card, "prompt">

export interface AttemptStart {
  readonly startedAt: number
  readonly modelCallId: string
  readonly rawRunId: string
}

export interface ModelCallState {
  readonly purpose: "conversation" | "structured-output" | "compaction-summary"
  readonly requestOrdinal?: number
}

export interface PersistedProjector {
  readonly turnId: string
  readonly revision: number
  readonly hasOlder: boolean
  readonly rootStatus: Projection.ProjectionState["status"]
  readonly title?: Projection.GeneratedTitle
  readonly steeringMessages: number
  readonly followUpMessages: number
  readonly usageState: Projection.UsageState
  readonly requestOrdinal: number
  readonly pendingContextOrdinal?: number
  readonly attemptStarts: ReadonlyArray<readonly [string, AttemptStart]>
  readonly settledAttemptKeys: ReadonlyArray<string>
  readonly modelCalls: ReadonlyArray<readonly [string, ModelCallState]>
  readonly activeAvailable: boolean
  readonly activeDepth: number
  readonly activeAccumulatedMillis: number
  readonly activeSince?: number
  readonly lastLifecycleAt?: number
  readonly nodes: ReadonlyArray<{
    readonly rawRunId: string
    readonly publicId: string
    readonly parentRawRunId?: string
    readonly parentUnitKey?: string
    readonly parentBlockId?: string
    readonly hidden: boolean
    readonly phase: number
    readonly status: Node["status"]
    readonly lifecycle: Node["lifecycle"]
    readonly started: boolean
    readonly attempt?: number
    readonly tools: ReadonlyArray<readonly [string, ToolState]>
    readonly cells: ReadonlyArray<readonly [string, CellState]>
  }>
  readonly cards: ReadonlyArray<PersistedCard>
  readonly pendingGroups: ReadonlyArray<{ readonly parentRawRunId: string; readonly toolCallId: string }>
  readonly fanOutTools: ReadonlyArray<
    readonly [string, { readonly parentRawRunId: string; readonly toolCallId: string }]
  >
  readonly authorizations: ReadonlyArray<readonly [string, AuthorizationState]>
}

export interface ProjectorCore {
  revision: number
  checkpoint: Projection.Checkpoint | undefined
  historyOmitted: boolean
  rootStatus: Projection.ProjectionState["status"]
  title: Projection.GeneratedTitle | undefined
  steeringMessages: number
  followUpMessages: number
}
