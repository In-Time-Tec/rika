export interface TranscriptRepair {
  readonly repaired: boolean
  readonly reason?: string
}

export const noTranscriptRepair: TranscriptRepair = { repaired: false }
export const transcriptRepair = (reason: string): TranscriptRepair => ({ repaired: true, reason })
