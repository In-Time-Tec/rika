export const maxMountedTranscriptRows = 3360

export const transcriptOverscanRows = 64

export const transcriptRenderableBandRows = 64

export const minimumMountedTranscriptRows = 1200

export const mountedTranscriptRowBudget = (viewportRows: number): number =>
  Math.min(
    maxMountedTranscriptRows,
    Math.max(minimumMountedTranscriptRows, Math.max(1, viewportRows) + transcriptOverscanRows * 2),
  )
