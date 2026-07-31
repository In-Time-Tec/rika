import { Context, Effect, Layer, Schema } from "effect"

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

export class Service extends Context.Service<Service, Interface>()("@rika/product/thread/repository/usage-repository/Service") {}

const emptyMaterialized: Materialized = {
  pricedAttempts: 0,
  unpricedAttempts: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
  sourceComplete: false,
}

export const memoryLayer = Layer.succeed(
  Service,
  Service.of({
    admitSource: (sourceId: string, turnId: string, threadId: string) =>
      Effect.succeed<SourceUsage>({ sourceId, turnId, threadId, revision: 0, projectionVersion, ...emptyMaterialized }),
    readSource: (): Effect.Effect<SourceUsage | undefined> => Effect.sync(() => undefined),
    readTurn: (): Effect.Effect<TurnUsage | undefined> => Effect.sync(() => undefined),
    readThread: () => Effect.succeed<Aggregate>({ turns: 0, revision: 0, projectionVersion, ...emptyMaterialized }),
    readGlobal: Effect.succeed<Aggregate>({ turns: 0, revision: 0, projectionVersion, ...emptyMaterialized }),
    loadSourceFold: (): Effect.Effect<undefined> => Effect.sync(() => undefined),
    commitSource: (sourceId: string, turnId: string, _revision: number, foldJson: string, totals: Materialized) =>
      Effect.succeed<CommitResult>({
        _tag: "Applied",
        value: { sourceId, turnId, threadId: "", revision: 0, projectionVersion, foldJson, ...totals },
      }),
    replaceSource: (
      sourceId: string,
      turnId: string,
      threadId: string,
      _version: number,
      _revision: number,
      foldJson: string,
      totals: Materialized,
    ) =>
      Effect.succeed<CommitResult>({
        _tag: "Applied",
        value: { sourceId, turnId, threadId, revision: 0, projectionVersion, foldJson, ...totals },
      }),
  }),
)
