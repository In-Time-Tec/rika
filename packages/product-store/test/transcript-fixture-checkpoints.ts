import * as TranscriptPage from "@rika/product/transcript-page"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Function } from "effect"
import * as Turn from "@rika/product/turn-record"

export const executionCheckpoint: {
  (
    target: Turn.AgentExecutionTurn,
    state: TranscriptProjection.ProjectionStateSource,
    status?: TranscriptPage.ExecutionCheckpoint["status"],
  ): TranscriptPage.ExecutionCheckpoint
  (
    state: TranscriptProjection.ProjectionStateSource,
    status?: TranscriptPage.ExecutionCheckpoint["status"],
  ): (target: Turn.AgentExecutionTurn) => TranscriptPage.ExecutionCheckpoint
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "_tag" in args[0],
  (
    target: Turn.AgentExecutionTurn,
    state: TranscriptProjection.ProjectionStateSource,
    status?: TranscriptPage.ExecutionCheckpoint["status"],
  ): TranscriptPage.ExecutionCheckpoint => ({
    executionKey: TranscriptCorrelation.executionKey(String(target.id)),
    executionId: String(target.id),
    cursor: state.checkpointCursor ?? "",
    sequence: state.revision,
    ...(status === undefined ? {} : { status }),
    state: TranscriptProjection.Projection.projectionState(state),
  }),
)

export const attachedExecutionCheckpoint: {
  (
    executionId: string,
    state: TranscriptProjection.ProjectionStateSource,
    parentExecutionKey: string,
    parent: TranscriptUnit.Unit,
    status?: TranscriptPage.ExecutionCheckpoint["status"],
  ): TranscriptPage.ExecutionCheckpoint
  (
    state: TranscriptProjection.ProjectionStateSource,
    parentExecutionKey: string,
    parent: TranscriptUnit.Unit,
    status?: TranscriptPage.ExecutionCheckpoint["status"],
  ): (executionId: string) => TranscriptPage.ExecutionCheckpoint
} = Function.dual(
  (args) => typeof args[0] === "string",
  (
    executionId: string,
    state: TranscriptProjection.ProjectionStateSource,
    parentExecutionKey: string,
    parent: TranscriptUnit.Unit,
    status?: TranscriptPage.ExecutionCheckpoint["status"],
  ): TranscriptPage.ExecutionCheckpoint => {
    if (parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
      throw new TypeError("Attached execution fixtures require a parent tool unit")
    return {
      executionKey: TranscriptCorrelation.executionKey(executionId),
      executionId,
      cursor: state.checkpointCursor ?? "",
      sequence: state.revision,
      ...(status === undefined ? {} : { status }),
      state: TranscriptProjection.Projection.projectionState(state),
      attachment: {
        parentExecutionKey,
        parentUnitKey: parent.key,
        parentId: parent.content.block.id,
        parentOrderKey: TranscriptOrdering.encodeUnitOrder(parent.order),
      },
    }
  },
)

export interface NestedProjectionFixture {
  readonly projection: TranscriptProjectionModel.Projection
  readonly parent: TranscriptUnit.Unit
  readonly checkpoints: ReadonlyArray<TranscriptPage.ExecutionCheckpoint>
}

export const nestedProjection: {
  (target: Turn.AgentExecutionTurn, childExecutionId: string): NestedProjectionFixture
  (childExecutionId: string): (target: Turn.AgentExecutionTurn) => NestedProjectionFixture
} = Function.dual(2, (target: Turn.AgentExecutionTurn, childExecutionId: string): NestedProjectionFixture => {
  const root = TranscriptProjection.Projection.project(target.id, target.prompt, [
    {
      cursor: "parent-tool",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 0,
      data: { tool_call_id: "parent", tool_name: "task", input: {} },
    },
    {
      cursor: "root-completed",
      sequence: 1,
      type: "execution.completed",
      createdAt: 1,
    },
  ])
  const parent = root.units.find(
    (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
  )
  if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
    throw new TypeError("Nested transcript fixture has no parent tool")
  const parentId = parent.content.block.id
  const child = TranscriptProjection.Projection.empty(childExecutionId, "child")
  const units = [
    ...root.units,
    ...child.units.map((candidate) =>
      Object.assign({}, candidate, {
        parentId,
        order: TranscriptOrdering.childOrder(parent.order, childExecutionId, candidate.order),
      }),
    ),
  ]
  return {
    projection: { ...root, units },
    parent,
    checkpoints: [
      executionCheckpoint(target, root, "completed"),
      attachedExecutionCheckpoint(
        childExecutionId,
        child,
        TranscriptCorrelation.executionKey(String(target.id)),
        parent,
      ),
    ],
  }
})

export const invalidCheckpointGraphs: {
  (
    target: Turn.AgentExecutionTurn,
    nested: NestedProjectionFixture,
    peerExecutionId: string,
  ): ReadonlyArray<InvalidCheckpointGraph>
  (
    nested: NestedProjectionFixture,
    peerExecutionId: string,
  ): (target: Turn.AgentExecutionTurn) => ReadonlyArray<InvalidCheckpointGraph>
} = Function.dual(
  3,
  (
    target: Turn.AgentExecutionTurn,
    nested: NestedProjectionFixture,
    peerExecutionId: string,
  ): ReadonlyArray<InvalidCheckpointGraph> => {
    const root = nested.checkpoints[0]!
    const child = nested.checkpoints[1]!
    if (child.attachment === undefined) throw new TypeError("Nested transcript fixture has no child attachment")
    const peerState = TranscriptProjection.Projection.empty(peerExecutionId, "peer")
    const peer = attachedExecutionCheckpoint(
      peerExecutionId,
      peerState,
      TranscriptCorrelation.executionKey(String(target.id)),
      nested.parent,
    )
    if (peer.attachment === undefined) throw new TypeError("Nested transcript fixture has no peer attachment")
    return [
      { name: "missing root", checkpoints: [child] },
      { name: "duplicate root", checkpoints: [root, root] },
      {
        name: "child cycle",
        checkpoints: [
          root,
          { ...child, attachment: { ...child.attachment, parentExecutionKey: peer.executionKey } },
          { ...peer, attachment: { ...peer.attachment, parentExecutionKey: child.executionKey } },
        ],
      },
      {
        name: "disconnected child",
        checkpoints: [
          root,
          {
            ...child,
            attachment: {
              ...child.attachment,
              parentExecutionKey: TranscriptCorrelation.executionKey(`missing:${child.executionId}`),
            },
          },
        ],
      },
    ]
  },
)

interface InvalidCheckpointGraph {
  readonly name: string
  readonly checkpoints: ReadonlyArray<TranscriptPage.ExecutionCheckpoint>
}
