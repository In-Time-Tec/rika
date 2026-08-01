import { Context, Effect, Layer, Schema } from "effect"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import type { Aggregate, CommitResult, Materialized, SourceUsage, TurnUsage } from "../../usage/usage-snapshot"

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

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/usage-repository/Service",
) {}

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
      Effect.succeed<SourceUsage>({
        sourceId,
        turnId,
        threadId,
        revision: 0,
        projectionVersion: UsageSnapshot.projectionVersion,
        ...emptyMaterialized,
      }),
    readSource: (): Effect.Effect<SourceUsage | undefined> => Effect.sync(() => undefined),
    readTurn: (): Effect.Effect<TurnUsage | undefined> => Effect.sync(() => undefined),
    readThread: () =>
      Effect.succeed<Aggregate>({
        turns: 0,
        revision: 0,
        projectionVersion: UsageSnapshot.projectionVersion,
        ...emptyMaterialized,
      }),
    readGlobal: Effect.succeed<Aggregate>({
      turns: 0,
      revision: 0,
      projectionVersion: UsageSnapshot.projectionVersion,
      ...emptyMaterialized,
    }),
    loadSourceFold: (): Effect.Effect<undefined> => Effect.sync(() => undefined),
    commitSource: (sourceId: string, turnId: string, _revision: number, foldJson: string, totals: Materialized) =>
      Effect.succeed<CommitResult>({
        _tag: "Applied",
        value: {
          sourceId,
          turnId,
          threadId: "",
          revision: 0,
          projectionVersion: UsageSnapshot.projectionVersion,
          foldJson,
          ...totals,
        },
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
        value: {
          sourceId,
          turnId,
          threadId,
          revision: 0,
          projectionVersion: UsageSnapshot.projectionVersion,
          foldJson,
          ...totals,
        },
      }),
  }),
)
