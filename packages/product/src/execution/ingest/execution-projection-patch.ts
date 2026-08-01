import * as IngestProjection from "./execution-projection-state"
import type { ProjectionOrigin, Patch, Snapshot } from "./execution-projection-contract"
import type { Pipeline } from "./execution-ingest-state"
import type { VisibleDelta } from "./execution-projection-types"

const attachments = (pipeline: Pipeline) =>
  new Map(
    [...pipeline.nodes].flatMap(([key, node]) =>
      node.attachment === undefined ? [] : ([[key, node.attachment]] as const),
    ),
  )

export const snapshot = (pipeline: Pipeline): Snapshot => {
  const root = pipeline.nodes.get(pipeline.rootKey)!
  return {
    threadId: pipeline.threadId,
    rootTurnId: pipeline.turnId,
    turn: pipeline.turn,
    streamId: pipeline.streamId,
    patchRevision: pipeline.patchRevision,
    state: IngestProjection.visibleState(root.fold),
    units: IngestProjection.globalProjectionUnits(pipeline.nodes, pipeline.order, attachments(pipeline)),
    ...(root.status === undefined ? {} : { rootStatus: root.status }),
  }
}

export const patch = (pipeline: Pipeline, origin: ProjectionOrigin, visible: VisibleDelta): Patch => {
  const root = pipeline.nodes.get(pipeline.rootKey)!
  const baseRevision = pipeline.patchRevision
  pipeline.patchRevision += 1
  return {
    threadId: pipeline.threadId,
    rootTurnId: pipeline.turnId,
    streamId: pipeline.streamId,
    baseRevision,
    patchRevision: pipeline.patchRevision,
    origin,
    state: IngestProjection.visibleState(root.fold),
    delta: IngestProjection.globalDelta(pipeline.nodes, visible, attachments(pipeline)),
    ...(root.status === undefined ? {} : { rootStatus: root.status }),
  }
}

export const attachmentsFor = (pipeline: Pipeline) => attachments(pipeline)
