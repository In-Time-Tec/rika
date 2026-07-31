import { Context, Effect, Schema } from "effect"

export const projectionVersion = 3

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

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("UsageRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly admitSource: (
    sourceId: string,
    turnId: string,
    threadId: string,
  ) => Effect.Effect<SourceUsage, RepositoryError>
  readonly readSource: (sourceId: string, turnId: string) => Effect.Effect<SourceUsage | undefined, RepositoryError>
  readonly readTurn: (turnId: string) => Effect.Effect<TurnUsage | undefined, RepositoryError>
  readonly readThread: (threadId: string) => Effect.Effect<Aggregate, RepositoryError>
  readonly readGlobal: Effect.Effect<Aggregate, RepositoryError>
  readonly loadSourceFold: (
    sourceId: string,
    turnId: string,
  ) => Effect.Effect<
    { readonly revision: number; readonly projectionVersion: number; readonly foldJson?: string } | undefined,
    RepositoryError
  >
  readonly commitSource: (
    sourceId: string,
    turnId: string,
    expectedRevision: number,
    foldJson: string,
    totals: Materialized,
  ) => Effect.Effect<CommitResult, RepositoryError>
  readonly replaceSource: (
    sourceId: string,
    turnId: string,
    threadId: string,
    expectedProjectionVersion: number,
    expectedRevision: number,
    foldJson: string,
    totals: Materialized,
  ) => Effect.Effect<CommitResult, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/sqlite-usage-repository/Service") {}

