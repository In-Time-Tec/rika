export const maxMountedTranscriptRows = 3360

export const transcriptOverscanRows = 64

export const transcriptRenderableBandRows = 64

export const minimumMountedTranscriptRows = 384

const minimumStreamingTranscriptRows = 1_200

const transcriptRowBudget = (viewportRows: number, minimumRows: number): number =>
  Math.min(maxMountedTranscriptRows, Math.max(minimumRows, Math.max(1, viewportRows) + transcriptOverscanRows * 2))

export const mountedTranscriptRowBudget = (viewportRows: number): number =>
  transcriptRowBudget(viewportRows, minimumMountedTranscriptRows)

export const mountedStreamingTranscriptRowBudget = (viewportRows: number): number =>
  transcriptRowBudget(viewportRows, minimumStreamingTranscriptRows)
