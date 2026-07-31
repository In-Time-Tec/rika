import * as Transcript from "@rika/transcript"
import { Effect, Function, Layer } from "effect"
import * as Database from "../src/product-database"
import * as Thread from "../src/thread-schema"
import * as ThreadRepository from "../src/thread-repository"
import * as TranscriptRepository from "../src/transcript-repository"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"

export const projectionVersion = 3

export const turn: {
  (index: number, threadId?: Thread.ThreadId): Turn.AgentExecutionTurn
  (threadId?: Thread.ThreadId): (index: number) => Turn.AgentExecutionTurn
} = Function.dual(
  (args) => typeof args[0] === "number",
  (index: number, threadId: Thread.ThreadId = Thread.ThreadId.make("thread-a")): Turn.AgentExecutionTurn => ({
    _tag: "AgentExecution",
    id: Turn.TurnId.make(`turn-${index}`),
    threadId,
    prompt: `prompt ${index}`,
    executionRoute: Turn.testExecutionRoute(),
    status: "completed",
    stopIntent: "none",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: index,
    updatedAt: index,
  }),
)

export const event = (index: number): Transcript.SourceEvent => ({
  cursor: `cursor-${index}`,
  sequence: index,
  type: index === 2 ? "execution.completed" : "model.output.completed",
  createdAt: index,
  text: `output ${index}`,
})

export const unit: {
  (turnId: Turn.TurnId, sequence: number, part: number, key: string): Transcript.Unit
  (sequence: number, part: number, key: string): (turnId: Turn.TurnId) => Transcript.Unit
} = Function.dual(
  4,
  (turnId: Turn.TurnId, sequence: number, part: number, key: string): Transcript.Unit => ({
    key,
    turnId,
    order: Transcript.unitOrder(key, sequence, part),
    revision: sequence,
    content: { _tag: "Entry", role: "assistant", text: key },
  }),
)

export const executionCheckpoint: {
  (
    target: Turn.AgentExecutionTurn,
    state: Transcript.ProjectionStateSource,
    status?: TranscriptRepository.ExecutionCheckpoint["status"],
  ): TranscriptRepository.ExecutionCheckpoint
  (
    state: Transcript.ProjectionStateSource,
    status?: TranscriptRepository.ExecutionCheckpoint["status"],
  ): (target: Turn.AgentExecutionTurn) => TranscriptRepository.ExecutionCheckpoint
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "_tag" in args[0],
  (
    target: Turn.AgentExecutionTurn,
    state: Transcript.ProjectionStateSource,
    status?: TranscriptRepository.ExecutionCheckpoint["status"],
  ): TranscriptRepository.ExecutionCheckpoint => ({
    executionKey: Transcript.executionKey(String(target.id)),
    executionId: String(target.id),
    cursor: state.checkpointCursor ?? "",
    sequence: state.revision,
    ...(status === undefined ? {} : { status }),
    state: Transcript.projectionState(state),
  }),
)

export const attachedExecutionCheckpoint: {
  (
    executionId: string,
    state: Transcript.ProjectionStateSource,
    parentExecutionKey: string,
    parent: Transcript.Unit,
    status?: TranscriptRepository.ExecutionCheckpoint["status"],
  ): TranscriptRepository.ExecutionCheckpoint
  (
    state: Transcript.ProjectionStateSource,
    parentExecutionKey: string,
    parent: Transcript.Unit,
    status?: TranscriptRepository.ExecutionCheckpoint["status"],
  ): (executionId: string) => TranscriptRepository.ExecutionCheckpoint
} = Function.dual(
  (args) => typeof args[0] === "string",
  (
    executionId: string,
    state: Transcript.ProjectionStateSource,
    parentExecutionKey: string,
    parent: Transcript.Unit,
    status?: TranscriptRepository.ExecutionCheckpoint["status"],
  ): TranscriptRepository.ExecutionCheckpoint => {
    if (parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
      throw new TypeError("Attached execution fixtures require a parent tool unit")
    return {
      executionKey: Transcript.executionKey(executionId),
      executionId,
      cursor: state.checkpointCursor ?? "",
      sequence: state.revision,
      ...(status === undefined ? {} : { status }),
      state: Transcript.projectionState(state),
      attachment: {
        parentExecutionKey,
        parentUnitKey: parent.key,
        parentId: parent.content.block.id,
        parentOrderKey: Transcript.encodeUnitOrder(parent.order),
      },
    }
  },
)

export interface NestedProjectionFixture {
  readonly projection: Transcript.Projection
  readonly parent: Transcript.Unit
  readonly checkpoints: ReadonlyArray<TranscriptRepository.ExecutionCheckpoint>
}

export const nestedProjection: {
  (target: Turn.AgentExecutionTurn, childExecutionId: string): NestedProjectionFixture
  (childExecutionId: string): (target: Turn.AgentExecutionTurn) => NestedProjectionFixture
} = Function.dual(2, (target: Turn.AgentExecutionTurn, childExecutionId: string): NestedProjectionFixture => {
  const root = Transcript.project(target.id, target.prompt, [
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
  const child = Transcript.empty(childExecutionId, "child")
  const units = [
    ...root.units,
    ...child.units.map((candidate) =>
      Object.assign({}, candidate, {
        parentId,
        order: Transcript.childOrder(parent.order, childExecutionId, candidate.order),
      }),
    ),
  ]
  return {
    projection: { ...root, units },
    parent,
    checkpoints: [
      executionCheckpoint(target, root, "completed"),
      attachedExecutionCheckpoint(childExecutionId, child, Transcript.executionKey(String(target.id)), parent),
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
    const peerState = Transcript.empty(peerExecutionId, "peer")
    const peer = attachedExecutionCheckpoint(
      peerExecutionId,
      peerState,
      Transcript.executionKey(String(target.id)),
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
              parentExecutionKey: Transcript.executionKey(`missing:${child.executionId}`),
            },
          },
        ],
      },
    ]
  },
)

interface InvalidCheckpointGraph {
  readonly name: string
  readonly checkpoints: ReadonlyArray<TranscriptRepository.ExecutionCheckpoint>
}

export const commitAll = Effect.fn("TranscriptRepositoryTest.commitAll")(function* (
  repository: TranscriptRepository.Interface,
  target: Turn.AgentExecutionTurn,
  projection: Transcript.Projection,
  expectedGeneration: number | undefined,
  version: number = projectionVersion,
  checkpoints: ReadonlyArray<TranscriptRepository.ExecutionCheckpoint> = [executionCheckpoint(target, projection)],
) {
  return yield* repository.commitDelta(
    target,
    Transcript.projectionState(projection),
    { upsert: projection.units, remove: [] },
    {
      executionCheckpoints: checkpoints,
      projectionVersion: version,
      expectedGeneration,
    },
  )
})

export const sqliteLayer = (filename: string) => {
  const database = Database.layer(filename)
  return Layer.mergeAll(
    database,
    ThreadRepository.layer.pipe(Layer.provide(database)),
    TurnRepository.layer.pipe(Layer.provide(database)),
    TranscriptRepository.layer.pipe(Layer.provide(database)),
  )
}

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })
