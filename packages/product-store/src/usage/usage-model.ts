export const projectionVersion = 4

export interface ActiveInterval {
  readonly start: number
  readonly end?: number
}

export interface Materialized {
  readonly costNanoUsd?: number
  readonly tokens?: number
  readonly activeMillis?: number
  readonly activeIntervals?: ReadonlyArray<ActiveInterval>
  readonly pricedAttempts: number
  readonly unpricedAttempts: number
  readonly countedAttempts: number
  readonly uncountedAttempts: number
  readonly sourceComplete: boolean
}

export interface SourceUsage extends Materialized {
  readonly sourceId: string
  readonly turnId: string
  readonly threadId: string
  readonly revision: number
  readonly projectionVersion: number
  readonly foldJson?: string
}

export interface TurnUsage extends Materialized {
  readonly turnId: string
  readonly threadId: string
  readonly revision: number
  readonly projectionVersion: number
}

export interface Aggregate extends Materialized {
  readonly turns: number
  readonly revision: number
  readonly projectionVersion: number
  readonly activeSince?: number
}

export type CommitResult =
  | { readonly _tag: "Applied"; readonly value: SourceUsage }
  | { readonly _tag: "Conflict"; readonly value: SourceUsage | undefined }
