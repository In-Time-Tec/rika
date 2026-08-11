export const cases = ["one", "ten-thousand", "alternating-empty"] as const
export type Case = (typeof cases)[number]
export type Source = "baseline" | "candidate"

export interface SqlAccounting {
  readonly totalEvents: number
  readonly eventsByTag: Readonly<Record<string, number>>
  readonly eventJsonBytes: number
  readonly operationResultBytes: number
  readonly modelPartEvents: number
  readonly modelResponseCommittedEvents: number
}

export interface Sample {
  readonly schemaVersion: 1
  readonly source: Source
  readonly mode: "baton"
  readonly case: Case
  readonly sample: number
  readonly warmup: boolean
  readonly output: { readonly bytes: number; readonly sha256: string }
  readonly correctness: {
    readonly durableModelParts: number
    readonly modelResponsesCommitted: number
    readonly terminalFinishes: number
  }
  readonly timing: {
    readonly wallMilliseconds: number
    readonly cpuMilliseconds: number
    readonly firstPreviewMilliseconds?: number
    readonly controlAckMilliseconds?: number
    readonly completionMilliseconds: number
  }
  readonly memory: {
    readonly peakHeapBytes: number
    readonly postGcHeapBytes: number
    readonly peakProcessTreeRssBytes?: number
    readonly postGcProcessTreeRssBytes?: number
    readonly bunHeapStats: Readonly<Record<string, number>>
    readonly allocatorRelief: { readonly status: "supported" | "unsupported"; readonly detail: string }
  }
  readonly batonSql: SqlAccounting
  readonly projection: { readonly commitProjectionCalls: number }
  readonly databases: Readonly<Record<string, unknown>>
  readonly identity: Readonly<Record<string, unknown>>
}

export interface Aggregate {
  readonly source: Source
  readonly mode: "baton"
  readonly case: Case
  readonly samples: ReadonlyArray<Sample>
  readonly median: Readonly<Record<string, number>>
}

export interface Comparison {
  readonly pass: boolean
  readonly failures: ReadonlyArray<string>
  readonly ratios: Readonly<Record<string, number>>
}
