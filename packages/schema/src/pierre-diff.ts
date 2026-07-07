import { Option, Result, Schema } from "effect"

export const FileDiffChangeType = Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"])
export type FileDiffChangeType = typeof FileDiffChangeType.Type

export const HunkContextContent = Schema.Struct({
  type: Schema.Literal("context"),
  lines: Schema.Int,
  additionLineIndex: Schema.Int,
  deletionLineIndex: Schema.Int,
}).annotate({ identifier: "Rika.PierreDiff.HunkContextContent" })
export interface HunkContextContent extends Schema.Schema.Type<typeof HunkContextContent> {}

export const HunkChangeContent = Schema.Struct({
  type: Schema.Literal("change"),
  deletions: Schema.Int,
  deletionLineIndex: Schema.Int,
  additions: Schema.Int,
  additionLineIndex: Schema.Int,
}).annotate({ identifier: "Rika.PierreDiff.HunkChangeContent" })
export interface HunkChangeContent extends Schema.Schema.Type<typeof HunkChangeContent> {}

export const HunkContent = Schema.Union([HunkContextContent, HunkChangeContent]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Rika.PierreDiff.HunkContent" }),
)
export type HunkContent = HunkContextContent | HunkChangeContent

export const Hunk = Schema.Struct({
  collapsedBefore: Schema.Int,
  additionStart: Schema.Int,
  additionCount: Schema.Int,
  additionLines: Schema.Int,
  additionLineIndex: Schema.Int,
  deletionStart: Schema.Int,
  deletionCount: Schema.Int,
  deletionLines: Schema.Int,
  deletionLineIndex: Schema.Int,
  hunkContent: Schema.Array(HunkContent),
  hunkContext: Schema.optional(Schema.String),
  hunkSpecs: Schema.optional(Schema.String),
  splitLineStart: Schema.Int,
  splitLineCount: Schema.Int,
  unifiedLineStart: Schema.Int,
  unifiedLineCount: Schema.Int,
  noEOFCRDeletions: Schema.Boolean,
  noEOFCRAdditions: Schema.Boolean,
}).annotate({ identifier: "Rika.PierreDiff.Hunk" })
export interface Hunk extends Schema.Schema.Type<typeof Hunk> {}

export const FileDiffMetadata = Schema.Struct({
  name: Schema.String,
  prevName: Schema.optional(Schema.String),
  lang: Schema.optional(Schema.String),
  newObjectId: Schema.optional(Schema.String),
  prevObjectId: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  prevMode: Schema.optional(Schema.String),
  type: FileDiffChangeType,
  hunks: Schema.Array(Hunk),
  splitLineCount: Schema.Int,
  unifiedLineCount: Schema.Int,
  isPartial: Schema.Boolean,
  deletionLines: Schema.Array(Schema.String),
  additionLines: Schema.Array(Schema.String),
  cacheKey: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.PierreDiff.FileDiffMetadata" })
export interface FileDiffMetadata extends Schema.Schema.Type<typeof FileDiffMetadata> {}

const decodeUnknownFileDiffMetadata = Schema.decodeUnknownResult(FileDiffMetadata)

export const decodeFileDiffMetadata = (value: unknown): Option.Option<FileDiffMetadata> => {
  const decoded = decodeUnknownFileDiffMetadata(value)
  return Result.isSuccess(decoded) ? Option.some(decoded.success) : Option.none()
}
