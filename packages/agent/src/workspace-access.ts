import { Time } from "@rika/core"
import { Database, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Ids, Workspace } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

export interface WorkspaceAccessInput extends Schema.Schema.Type<typeof WorkspaceAccessInput> {}
export const WorkspaceAccessInput = Schema.Struct({
  workspace_id: Ids.WorkspaceId,
  user_id: Schema.optional(Ids.UserId),
  action: Workspace.AccessAction,
}).annotate({ identifier: "Rika.Agent.WorkspaceAccess.WorkspaceAccessInput" })

export interface ThreadAccessInput extends Schema.Schema.Type<typeof ThreadAccessInput> {}
export const ThreadAccessInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  user_id: Schema.optional(Ids.UserId),
  action: Workspace.AccessAction,
}).annotate({ identifier: "Rika.Agent.WorkspaceAccess.ThreadAccessInput" })

export class WorkspaceAccessError extends Schema.TaggedErrorClass<WorkspaceAccessError>()("WorkspaceAccessError", {
  message: Schema.String,
  operation: Schema.String,
  workspace_id: Schema.optional(Ids.WorkspaceId),
  thread_id: Schema.optional(Ids.ThreadId),
  user_id: Schema.optional(Ids.UserId),
}) {}

export class WorkspaceAccessDenied extends Schema.TaggedErrorClass<WorkspaceAccessDenied>()("WorkspaceAccessDenied", {
  message: Schema.String,
  action: Workspace.AccessAction,
  workspace_id: Ids.WorkspaceId,
  user_id: Schema.optional(Ids.UserId),
}) {}

export type RunError =
  | WorkspaceAccessError
  | WorkspaceAccessDenied
  | Database.DatabaseError
  | ThreadProjection.ThreadProjectionError
  | WorkspaceStore.WorkspaceStoreError

export interface Interface {
  readonly authorizeWorkspace: (input: WorkspaceAccessInput) => Effect.Effect<Workspace.AccessDecision, RunError>
  readonly requireWorkspace: (input: WorkspaceAccessInput) => Effect.Effect<Workspace.AccessDecision, RunError>
  readonly authorizeThread: (input: ThreadAccessInput) => Effect.Effect<Workspace.AccessDecision, RunError>
  readonly requireThread: (input: ThreadAccessInput) => Effect.Effect<Workspace.AccessDecision, RunError>
  readonly ensureWorkspaceForCreate: (input: WorkspaceAccessInput) => Effect.Effect<Workspace.AccessDecision, RunError>
  readonly filterReadableThreads: (
    summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
    userId?: Ids.UserId,
  ) => Effect.Effect<ReadonlyArray<ThreadProjection.ThreadSummary>, RunError>
  readonly filterDiscoverableThreads: (
    summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
    userId?: Ids.UserId,
  ) => Effect.Effect<ReadonlyArray<ThreadProjection.ThreadSummary>, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/WorkspaceAccess") {}

interface Dependencies {
  readonly database: Database.Interface
  readonly projection: ThreadProjection.Interface
  readonly workspaceStore: WorkspaceStore.Interface
  readonly time: Time.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const projection = yield* ThreadProjection.Service
    const workspaceStore = yield* WorkspaceStore.Service
    const time = yield* Time.Service
    const dependencies: Dependencies = { database, projection, workspaceStore, time }

    return Service.of({
      authorizeWorkspace: Effect.fn("WorkspaceAccess.authorizeWorkspace")(function* (input: WorkspaceAccessInput) {
        return yield* authorizeWorkspaceFromStore(dependencies, input)
      }),
      requireWorkspace: Effect.fn("WorkspaceAccess.requireWorkspace")(function* (input: WorkspaceAccessInput) {
        return yield* requireDecision(yield* authorizeWorkspaceFromStore(dependencies, input))
      }),
      authorizeThread: Effect.fn("WorkspaceAccess.authorizeThread")(function* (input: ThreadAccessInput) {
        return yield* authorizeThreadFromProjection(dependencies, input)
      }),
      requireThread: Effect.fn("WorkspaceAccess.requireThread")(function* (input: ThreadAccessInput) {
        return yield* requireDecision(yield* authorizeThreadFromProjection(dependencies, input))
      }),
      ensureWorkspaceForCreate: Effect.fn("WorkspaceAccess.ensureWorkspaceForCreate")(function* (
        input: WorkspaceAccessInput,
      ) {
        return yield* requireDecision(yield* ensureWorkspaceForCreateInternal(dependencies, input))
      }),
      filterReadableThreads: Effect.fn("WorkspaceAccess.filterReadableThreads")(function* (
        summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
        userId?: Ids.UserId,
      ) {
        if (userId === undefined) return summaries
        const decisions = yield* Effect.forEach(summaries, (summary) =>
          authorizeThreadSummary(dependencies, summary, {
            thread_id: summary.thread_id,
            user_id: userId,
            action: "read",
          }),
        )
        return summaries.filter((_summary, index) => decisions[index]?.allowed === true)
      }),
      filterDiscoverableThreads: Effect.fn("WorkspaceAccess.filterDiscoverableThreads")(function* (
        summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
        userId?: Ids.UserId,
      ) {
        if (userId === undefined) return summaries
        const decisions = yield* Effect.forEach(summaries, (summary) =>
          authorizeThreadDiscovery(dependencies, summary, userId),
        )
        return summaries.filter((_summary, index) => decisions[index]?.allowed === true)
      }),
    })
  }),
)

export const allowAllLayer = Layer.succeed(
  Service,
  Service.of({
    authorizeWorkspace: (input) => Effect.succeed(allow(input)),
    requireWorkspace: (input) => Effect.succeed(allow(input)),
    authorizeThread: (input) =>
      Effect.succeed(
        allow({
          workspace_id: Ids.WorkspaceId.make("workspace_fake_access"),
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          action: input.action,
        }),
      ),
    requireThread: (input) =>
      Effect.succeed(
        allow({
          workspace_id: Ids.WorkspaceId.make("workspace_fake_access"),
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          action: input.action,
        }),
      ),
    ensureWorkspaceForCreate: (input) => Effect.succeed(allow(input)),
    filterReadableThreads: (summaries) => Effect.succeed(summaries),
    filterDiscoverableThreads: (summaries) => Effect.succeed(summaries),
  }),
)

export const authorizeWorkspace = Effect.fn("WorkspaceAccess.authorizeWorkspace.call")(function* (
  input: WorkspaceAccessInput,
) {
  const service = yield* Service
  return yield* service.authorizeWorkspace(input)
})

export const requireWorkspace = Effect.fn("WorkspaceAccess.requireWorkspace.call")(function* (
  input: WorkspaceAccessInput,
) {
  const service = yield* Service
  return yield* service.requireWorkspace(input)
})

export const authorizeThread = Effect.fn("WorkspaceAccess.authorizeThread.call")(function* (input: ThreadAccessInput) {
  const service = yield* Service
  return yield* service.authorizeThread(input)
})

export const requireThread = Effect.fn("WorkspaceAccess.requireThread.call")(function* (input: ThreadAccessInput) {
  const service = yield* Service
  return yield* service.requireThread(input)
})

export const ensureWorkspaceForCreate = Effect.fn("WorkspaceAccess.ensureWorkspaceForCreate.call")(function* (
  input: WorkspaceAccessInput,
) {
  const service = yield* Service
  return yield* service.ensureWorkspaceForCreate(input)
})

export const filterReadableThreads = Effect.fn("WorkspaceAccess.filterReadableThreads.call")(function* (
  summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
  userId?: Ids.UserId,
) {
  const service = yield* Service
  return yield* service.filterReadableThreads(summaries, userId)
})

export const filterDiscoverableThreads = Effect.fn("WorkspaceAccess.filterDiscoverableThreads.call")(function* (
  summaries: ReadonlyArray<ThreadProjection.ThreadSummary>,
  userId?: Ids.UserId,
) {
  const service = yield* Service
  return yield* service.filterDiscoverableThreads(summaries, userId)
})

const authorizeWorkspaceFromStore = (dependencies: Dependencies, input: WorkspaceAccessInput) =>
  Effect.gen(function* () {
    if (input.user_id === undefined) return allow(input)
    const membership = yield* dependencies.workspaceStore.getMembership({
      workspace_id: input.workspace_id,
      user_id: input.user_id,
    })
    if (membership === undefined) {
      return deny(input, `User ${input.user_id} is not a member of workspace ${input.workspace_id}`)
    }
    if (input.action === "admin" && membership.role !== "owner") {
      return deny(input, `User ${input.user_id} is not an owner of workspace ${input.workspace_id}`)
    }
    return allow(input)
  })

const authorizeThreadFromProjection = (dependencies: Dependencies, input: ThreadAccessInput) =>
  Effect.gen(function* () {
    const summary = yield* dependencies.projection
      .getThread(input.thread_id)
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    if (summary === undefined) {
      return yield* new WorkspaceAccessError({
        message: `Thread ${input.thread_id} does not exist`,
        operation: "authorizeThread",
        thread_id: input.thread_id,
        ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
      })
    }
    return yield* authorizeThreadSummary(dependencies, summary, input)
  })

const authorizeThreadSummary = (
  dependencies: Dependencies,
  summary: ThreadProjection.ThreadSummary,
  input: ThreadAccessInput,
) =>
  Effect.gen(function* () {
    const workspaceInput: WorkspaceAccessInput = {
      workspace_id: summary.workspace_id,
      ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
      action: input.action,
    }
    if (input.user_id === undefined) return allow(workspaceInput)

    const readDecision = yield* authorizeThreadRead(dependencies, summary, workspaceInput)
    if (!readDecision.allowed) return readDecision
    if (input.action === "read") return readDecision
    if (input.action === "write" && summary.user_id !== undefined && summary.user_id === input.user_id) {
      return readDecision
    }
    return yield* authorizeWorkspaceFromStore(dependencies, workspaceInput)
  })

const authorizeThreadRead = (
  dependencies: Dependencies,
  summary: ThreadProjection.ThreadSummary,
  input: WorkspaceAccessInput,
) =>
  Effect.gen(function* () {
    if (summary.visibility === "unlisted") return allow(input)
    if (summary.user_id !== undefined && summary.user_id === input.user_id) return allow(input)
    if (summary.visibility === "private") {
      return deny(input, `Thread ${summary.thread_id} is private`)
    }
    return yield* authorizeWorkspaceFromStore(dependencies, input)
  })

const authorizeThreadDiscovery = (
  dependencies: Dependencies,
  summary: ThreadProjection.ThreadSummary,
  userId: Ids.UserId,
) => {
  const input: WorkspaceAccessInput = { workspace_id: summary.workspace_id, user_id: userId, action: "read" }
  if (summary.user_id !== undefined && summary.user_id === userId) return Effect.succeed(allow(input))
  if (summary.visibility === "unlisted") return Effect.succeed(deny(input, `Thread ${summary.thread_id} is unlisted`))
  return authorizeThreadRead(dependencies, summary, input)
}

const ensureWorkspaceForCreateInternal = (dependencies: Dependencies, input: WorkspaceAccessInput) =>
  Effect.gen(function* () {
    if (input.user_id === undefined) return allow(input)
    const existing = yield* authorizeWorkspaceFromStore(dependencies, input)
    if (existing.allowed) return existing

    const hasMembers = yield* dependencies.workspaceStore.workspaceHasMembers(input.workspace_id)
    if (hasMembers) return existing

    const createdAt = yield* dependencies.time.nowMillis
    yield* dependencies.workspaceStore.putMembership({
      workspace_id: input.workspace_id,
      user_id: input.user_id,
      role: "owner",
      created_at: createdAt,
    })
    return allow(input)
  })

const requireDecision = (decision: Workspace.AccessDecision) =>
  decision.allowed
    ? Effect.succeed(decision)
    : Effect.fail(
        new WorkspaceAccessDenied({
          message: decision.reason ?? "Workspace access denied",
          action: decision.action,
          workspace_id: decision.workspace_id,
          ...(decision.user_id === undefined ? {} : { user_id: decision.user_id }),
        }),
      )

const allow = (input: WorkspaceAccessInput): Workspace.AccessDecision => ({
  allowed: true,
  action: input.action,
  workspace_id: input.workspace_id,
  ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
})

const deny = (input: WorkspaceAccessInput, reason: string): Workspace.AccessDecision => ({
  allowed: false,
  action: input.action,
  workspace_id: input.workspace_id,
  ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
  reason,
})
