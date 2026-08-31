import type { RunEvent } from "generalist/runtime"
import type { Unit } from "@rika/product/execution-transcript-contract"
import type { AuthorizationProjection } from "../authorization"
import type { CellProjection } from "../cell/state"
import type { DiagnosticProjection } from "../diagnostic"
import type { Card, Node } from "../model"
import type { ProjectorCore } from "../persistence"
import type { SemanticModelResponseEvent, SemanticTreeEvent } from "../semantic/event"
import type { SteeringProjection } from "../steering"
import type { SubagentCardProjection } from "../subagent/card"
import type { ToolUnitProjection } from "../tool/unit"
import type { UsageAccounting } from "../usage"
import type { ProjectorRecoveryIndex } from "./projector-recovery"

export interface ProjectorEventContext {
  readonly core: ProjectorCore
  readonly units: Map<string, Unit>
  readonly nodes: Map<string, Node>
  readonly cardsByInvocation: Map<string, Card>
  readonly cardsByChild: Map<string, Card>
  readonly formattedCellSources: Map<string, string>
  readonly usage: UsageAccounting
  readonly recovery: ProjectorRecoveryIndex
  readonly semanticResponse: { readonly apply: (node: Node, event: SemanticModelResponseEvent) => void }
  readonly steering: Pick<SteeringProjection, "accept" | "consume" | "discard">
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly remove: (key: string) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly settleNode: (
    node: Node,
    status: "completed" | "failed" | "cancelled",
    event: RunEvent.RunEvent,
    detail?: string,
  ) => void
  readonly authorization: Pick<
    AuthorizationProjection,
    "putAuthorization" | "resolveAuthorization" | "settleAuthorizations"
  >
  readonly cells: Pick<CellProjection, "openCell" | "progressCell" | "completeCell">
  readonly diagnostics: Pick<DiagnosticProjection, "notice" | "error" | "modelFailureError" | "executionFailureError">
  readonly subagents: Pick<SubagentCardProjection, "cardFor" | "updateCard" | "groupCards" | "bindChild">
  readonly tools: Pick<ToolUnitProjection, "toolState" | "putTool" | "updateTool">
}

export type ProjectorEventHandler = (
  context: ProjectorEventContext,
  treeEvent: SemanticTreeEvent,
  node: Node,
) => boolean
