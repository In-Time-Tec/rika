import type { AttemptCost } from "./usage-attempt"
import type { ActiveEvent, DeliveryIdentity } from "./usage-event"
import type { Interval } from "./usage-active-time"
import { noTotals, type Totals } from "./usage-total"

export const projectionVersion = 3

export interface Materialized {
  readonly costNanoUsd?: number
  readonly tokens?: number
  readonly activeMillis?: number
  readonly activeIntervals?: ReadonlyArray<Interval>
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

export interface Snapshot {
  readonly turns: ReadonlyMap<string, Totals>
  readonly threads: ReadonlyMap<string, Totals>
  readonly global: Totals
  readonly deliveries: ReadonlyMap<string, DeliveryIdentity>
  readonly attempts: ReadonlyMap<string, AttemptCost>
  readonly executionAttempts: ReadonlyMap<string, ReadonlySet<string>>
  readonly activeEvents: ReadonlyMap<string, ActiveEvent>
  readonly executionEvents: ReadonlyMap<string, ReadonlyArray<ActiveEvent>>
}

export const empty: Snapshot = {
  turns: new Map(),
  threads: new Map(),
  global: noTotals,
  deliveries: new Map(),
  attempts: new Map(),
  executionAttempts: new Map(),
  activeEvents: new Map(),
  executionEvents: new Map(),
}
