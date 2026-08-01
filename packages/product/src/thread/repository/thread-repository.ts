import { Context, Effect, Schema } from "effect"
import { Thread, ThreadId, ThreadLineage } from "@rika/product/thread-record"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadRepositoryError", {
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly id: ThreadId
  readonly workspace: string
  readonly title: string
  readonly lineage?: ThreadLineage
  readonly now: number
}

export interface ListInput {
  readonly includeArchived?: boolean
  readonly limit?: number
  readonly query?: string
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Thread, RepositoryError>
  readonly get: (id: ThreadId) => Effect.Effect<Thread | undefined, RepositoryError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Thread>, RepositoryError>
  readonly listAll: Effect.Effect<ReadonlyArray<Thread>, RepositoryError>
  readonly rename: (id: ThreadId, title: string, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly renameIfTitle: (
    id: ThreadId,
    expected: string,
    title: string,
    now: number,
  ) => Effect.Effect<Thread | undefined, RepositoryError>
  readonly label: (id: ThreadId, labels: ReadonlyArray<string>, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly setPinned: (id: ThreadId, pinned: boolean, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly setArchived: (id: ThreadId, archived: boolean, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly remove: (id: ThreadId) => Effect.Effect<void, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/thread-repository/Service",
) {}
