import { Function, Schema } from "effect"

export const Thresholds = Schema.Struct({
  contextWindow: Schema.Finite,
  reserveTokens: Schema.Finite,
  keepRecentTokens: Schema.Finite,
  toolOutputMaxBytes: Schema.Finite,
})
export type Thresholds = typeof Thresholds.Type

export const Analysis = Schema.Struct({
  contextTokens: Schema.Finite,
  contextWindow: Schema.Finite,
  reserveTokens: Schema.Finite,
  availableTokens: Schema.Finite,
  utilization: Schema.Finite,
  shouldCompact: Schema.Boolean,
  checkpointCursor: Schema.optionalKey(Schema.String),
  checkpointDigest: Schema.optionalKey(Schema.String),
})
export type Analysis = typeof Analysis.Type

export const analyze: {
  (
    thresholds: Thresholds,
    checkpoint?: { readonly cursor: string; readonly digest: string },
  ): (contextTokens: number) => Analysis
  (
    contextTokens: number,
    thresholds: Thresholds,
    checkpoint?: { readonly cursor: string; readonly digest: string },
  ): Analysis
} = Function.dual(
  (args) => args.length >= 2,
  (
    contextTokens: number,
    thresholds: Thresholds,
    checkpoint?: { readonly cursor: string; readonly digest: string },
  ): Analysis => {
    const availableTokens = Math.max(0, thresholds.contextWindow - thresholds.reserveTokens)
    return {
      contextTokens,
      contextWindow: thresholds.contextWindow,
      reserveTokens: thresholds.reserveTokens,
      availableTokens,
      utilization: thresholds.contextWindow === 0 ? 1 : contextTokens / thresholds.contextWindow,
      shouldCompact: contextTokens > availableTokens,
      ...(checkpoint === undefined ? {} : { checkpointCursor: checkpoint.cursor, checkpointDigest: checkpoint.digest }),
    }
  },
)

export const format = (analysis: Analysis) =>
  `${analysis.contextTokens}/${analysis.contextWindow} tokens (${Math.round(analysis.utilization * 100)}%), ${analysis.availableTokens} available${analysis.shouldCompact ? ", compaction required" : ""}${analysis.checkpointCursor === undefined ? "" : `, checkpoint ${analysis.checkpointCursor}`}`
