import type { StyledText, TextChunk, TextRenderable } from "@opentui/core"
import type { Model } from "../../../state/model"
import type { PathTarget } from "../../../presentation/transcript/tool/detail-types"
import type { TranscriptUnit } from "../../../presentation/transcript/tool/types"

export interface TranscriptRenderableRecord {
  readonly key: string
  revision: string
  readonly renderable: TextRenderable
  spinnerChunk?: number
}

export interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
  readonly selectable?: boolean
  readonly spinnerChunk?: number
  readonly targets?: ReadonlyArray<PathTarget>
  readonly pointer?: boolean
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}

export interface TranscriptAnchorTarget {
  readonly key: string
  readonly screenY: number
  readonly row: number
  readonly scrollTop: number
}

export interface TranscriptAnchor extends TranscriptAnchorTarget {
  readonly fallbacks: ReadonlyArray<TranscriptAnchorTarget>
}

export type PendingTranscriptPosition =
  | {
      readonly _tag: "Anchor"
      readonly anchor: TranscriptAnchor | undefined
      readonly threadId: string | undefined
      readonly scrollBy: number
      readonly nearBottom: boolean
    }
  | {
      readonly _tag: "Follow"
      readonly threadId: string | undefined
    }

export interface TranscriptRenderInput {
  readonly entries: Model["entries"]
  readonly blocks: Model["blocks"]
  readonly items: Model["items"]
  readonly expandedRowKeys: Model["expandedRowKeys"]
  readonly explicitlyCollapsedRowKeys: Model["explicitlyCollapsedRowKeys"]
  readonly detailSelection: Model["detailSelection"]
  readonly width: number
  readonly windowEnd: number
  readonly animationTick: number
}

export interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: import("../../../state/changed-file").ChangedFile
  readonly nameIndex?: number
}

export type SurfaceUnit = TranscriptUnit
