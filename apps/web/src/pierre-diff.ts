import { Common, PierreDiff } from "@rika/schema"
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs"
import { Option } from "effect"

export interface WebPierreDiff {
  readonly payload_id: string
  readonly file_name: string
  readonly additions: number
  readonly deletions: number
  readonly file_diff: FileDiffMetadata
}

export interface PierreDiffMountInput {
  readonly container: HTMLElement
  readonly file_diff: FileDiffMetadata
  readonly theme_type: "light" | "dark"
  readonly onRenderError: (message: string) => void
}

export interface PierreDiffHandle {
  readonly update: (fileDiff: FileDiffMetadata) => void
  readonly destroy: () => void
}

export const mountPierreDiff = (input: PierreDiffMountInput): PierreDiffHandle => {
  const instance = new FileDiff({
    disableErrorHandling: false,
    diffStyle: "unified",
    overflow: "scroll",
    themeType: input.theme_type,
  })
  render(instance, input.container, input.file_diff, input.onRenderError)
  return {
    update: (fileDiff) => render(instance, input.container, fileDiff, input.onRenderError, true),
    destroy: () => {
      try {
        instance.cleanUp()
      } finally {
        input.container.replaceChildren()
      }
    },
  }
}

export const collectPierreDiffPayloads = (
  value: Common.JsonValue | undefined,
): ReadonlyArray<Record<string, Common.JsonValue>> => {
  if (value === undefined) return []
  const payloads: Array<Record<string, Common.JsonValue>> = []
  collect(value, payloads)
  return payloads
}

export const toWebPierreDiff = (
  payload: Record<string, Common.JsonValue>,
  payloadId: string,
): WebPierreDiff | undefined => {
  const fileDiff = asFileDiffMetadata(payload.file_diff)
  if (fileDiff === undefined) return undefined
  return toWebPierreDiffFromFileDiff(fileDiff, payloadId, payloadFileName(payload))
}

export const toWebPierreDiffFromFileDiff = (
  fileDiff: FileDiffMetadata,
  payloadId: string,
  fileName?: string,
): WebPierreDiff => {
  const stats = diffStats(fileDiff)
  return {
    payload_id: payloadId,
    file_name: fileName ?? fileDiff.name,
    additions: stats.additions,
    deletions: stats.deletions,
    file_diff: fileDiff,
  }
}

export const payloadFileName = (payload: Record<string, Common.JsonValue>): string | undefined => {
  const explicit = stringField(payload, "file_name")
  if (explicit !== undefined) return explicit
  const fileDiff = payload.file_diff
  if (!isObject(fileDiff)) return undefined
  return stringField(fileDiff, "name")
}

export const asFileDiffMetadata = (value: unknown): FileDiffMetadata | undefined => {
  const decoded = Option.getOrUndefined(PierreDiff.decodeFileDiffMetadata(value))
  return decoded === undefined ? undefined : toPierreFileDiffMetadata(decoded)
}

type PierreHunk = FileDiffMetadata["hunks"][number]
type PierreHunkContent = PierreHunk["hunkContent"][number]

const toPierreFileDiffMetadata = (diff: PierreDiff.FileDiffMetadata): FileDiffMetadata => ({
  name: diff.name,
  type: diff.type,
  hunks: diff.hunks.map(toPierreHunk),
  splitLineCount: diff.splitLineCount,
  unifiedLineCount: diff.unifiedLineCount,
  isPartial: diff.isPartial,
  deletionLines: [...diff.deletionLines],
  additionLines: [...diff.additionLines],
  ...(diff.prevName === undefined ? {} : { prevName: diff.prevName }),
  ...(diff.lang === undefined ? {} : { lang: diff.lang }),
  ...(diff.newObjectId === undefined ? {} : { newObjectId: diff.newObjectId }),
  ...(diff.prevObjectId === undefined ? {} : { prevObjectId: diff.prevObjectId }),
  ...(diff.mode === undefined ? {} : { mode: diff.mode }),
  ...(diff.prevMode === undefined ? {} : { prevMode: diff.prevMode }),
  ...(diff.cacheKey === undefined ? {} : { cacheKey: diff.cacheKey }),
})

const toPierreHunk = (hunk: PierreDiff.Hunk): PierreHunk => ({
  collapsedBefore: hunk.collapsedBefore,
  additionStart: hunk.additionStart,
  additionCount: hunk.additionCount,
  additionLines: hunk.additionLines,
  additionLineIndex: hunk.additionLineIndex,
  deletionStart: hunk.deletionStart,
  deletionCount: hunk.deletionCount,
  deletionLines: hunk.deletionLines,
  deletionLineIndex: hunk.deletionLineIndex,
  hunkContent: hunk.hunkContent.map(toPierreHunkContent),
  ...(hunk.hunkContext === undefined ? {} : { hunkContext: hunk.hunkContext }),
  ...(hunk.hunkSpecs === undefined ? {} : { hunkSpecs: hunk.hunkSpecs }),
  splitLineStart: hunk.splitLineStart,
  splitLineCount: hunk.splitLineCount,
  unifiedLineStart: hunk.unifiedLineStart,
  unifiedLineCount: hunk.unifiedLineCount,
  noEOFCRDeletions: hunk.noEOFCRDeletions,
  noEOFCRAdditions: hunk.noEOFCRAdditions,
})

const toPierreHunkContent = (content: PierreDiff.HunkContent): PierreHunkContent =>
  content.type === "context"
    ? {
        type: "context",
        lines: content.lines,
        additionLineIndex: content.additionLineIndex,
        deletionLineIndex: content.deletionLineIndex,
      }
    : {
        type: "change",
        deletions: content.deletions,
        deletionLineIndex: content.deletionLineIndex,
        additions: content.additions,
        additionLineIndex: content.additionLineIndex,
      }

const render = (
  instance: FileDiff,
  container: HTMLElement,
  fileDiff: FileDiffMetadata,
  onRenderError: (message: string) => void,
  forceRender = false,
): void => {
  try {
    instance.render({ containerWrapper: container, fileDiff, forceRender })
  } catch (cause) {
    onRenderError(errorMessage(cause))
  }
}

const collect = (value: Common.JsonValue, payloads: Array<Record<string, Common.JsonValue>>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, payloads)
    return
  }
  if (!isObject(value)) return
  if (isPierreDiffPayload(value)) {
    payloads.push(value)
    return
  }
  for (const item of Object.values(value)) collect(item, payloads)
}

const isPierreDiffPayload = (value: Record<string, Common.JsonValue>): boolean =>
  value.kind === "diff" && value.renderer === "@pierre/diffs" && value.file_diff !== undefined

const diffStats = (fileDiff: FileDiffMetadata): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions
        deletions += content.deletions
      }
    }
  }
  return { additions, deletions }
}

const stringField = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

const isObject = (value: unknown): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
