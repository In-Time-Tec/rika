import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"

export interface ProjectionNode {
  readonly executionId: string
  readonly key: string
  readonly parentKey: string | undefined
  fold: TranscriptProjection.ProjectionFold
}

export interface Attachment {
  readonly parentId: string
  readonly parentUnitKey: string
  readonly parentToolId: string
  readonly parentOrder: TranscriptUnit.UnitOrder
}

export interface ProjectionDelta {
  readonly units: Map<string, { readonly owner: string; readonly unit?: TranscriptUnit.Unit }>
  readonly checkpoints: Set<string>
}

export type VisibleDelta = Map<string, { readonly owner: string; readonly unit?: TranscriptUnit.Unit }>
