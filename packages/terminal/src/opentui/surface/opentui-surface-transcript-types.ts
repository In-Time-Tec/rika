import type { StyledText, TextChunk, TextRenderable } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"
import type { TranscriptUnit } from "../../presentation/transcript/transcript-tool-types"

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
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}

export interface TranscriptAnchor {
  readonly key: string
  readonly screenY: number
}

export type PendingTranscriptPosition =
  | {
      readonly _tag: "Anchor"
      readonly token: number
      readonly anchor: TranscriptAnchor | undefined
      readonly threadId: string | undefined
      readonly scrollHeight: number
      readonly scrollBy: number
      readonly nearBottom: boolean
    }
  | {
      readonly _tag: "Follow"
      readonly token: number
      readonly threadId: string | undefined
    }

export interface TranscriptRenderInput {
  readonly entries: Model["entries"]
  readonly blocks: Model["blocks"]
  readonly items: Model["items"]
  readonly expandedRowKeys: Model["expandedRowKeys"]
  readonly detailSelection: Model["detailSelection"]
  readonly width: number
  readonly windowEnd: number
  readonly rowWindowEnd: number
}

export interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: import("../../state/model/terminal-changed-file").ChangedFile
  readonly nameIndex?: number
}

export type SurfaceUnit = TranscriptUnit
