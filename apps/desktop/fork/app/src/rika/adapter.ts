import type { Event, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import type * as ServerService from "@rika/product/server-service"
import * as Thread from "@rika/product/thread-record"
import * as ThreadSummary from "@rika/product/thread-summary"
import { Deferred, Effect, Fiber, Schema, Semaphore } from "effect"
import { runThreadFeed } from "./events"
import { RikaCatalog, type RikaCatalog as RikaCatalogValue } from "./adapter-catalog"
import { RikaProjectionError, translateInteractiveEvent, type ProjectionState } from "./projection-events"
import { projectThread } from "./projection"

type AuthorizationReply = "once" | "reject"
type PromptPart = Parameters<InteractiveSession["submit"]>[2] extends ReadonlyArray<infer A> | undefined ? A : never

type MessageWithParts = { readonly info: Message; readonly parts: ReadonlyArray<Part> }
type Emit = (workspace: string, events: ReadonlyArray<Event>) => void

export class RikaAdapterError extends Schema.TaggedErrorClass<RikaAdapterError>()("RikaAdapterError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type RikaDirectoryRuntime = {
  readonly workspace: string
  readonly ready: Effect.Effect<InteractiveSession, RikaAdapterError>
  readonly catalog: Effect.Effect<RikaCatalogValue, RikaAdapterError>
  readonly listThreads: (input?: {
    readonly search?: string
    readonly includeArchived?: boolean
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Session>, RikaAdapterError>
  readonly createThread: Effect.Effect<Session, RikaAdapterError>
  readonly selectThread: (threadId: string) => Effect.Effect<void, RikaAdapterError>
  readonly getThread: (threadId: string) => Session | undefined
  readonly getMessages: (threadId: string) => ReadonlyArray<MessageWithParts>
  readonly getStatus: (threadId: string) => SessionStatus | undefined
  readonly getPermissions: () => ReadonlyArray<import("@opencode-ai/sdk/v2/client").PermissionRequest>
  readonly submit: (input: {
    readonly threadId: string
    readonly prompt: string
    readonly mode?: Parameters<InteractiveSession["submit"]>[1]
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly fastMode?: boolean
    readonly submissionId?: string
  }) => Effect.Effect<void, RikaAdapterError>
  readonly shell: (input: {
    readonly threadId: string
    readonly command: string
    readonly incognito: boolean
  }) => Effect.Effect<void, RikaAdapterError>
  readonly cancel: (threadId: string) => Effect.Effect<void, RikaAdapterError>
  readonly rename: (input: {
    readonly threadId: string
    readonly title: string
  }) => Effect.Effect<void, RikaAdapterError>
  readonly archive: (input: {
    readonly threadId: string
    readonly archived: boolean
  }) => Effect.Effect<void, RikaAdapterError>
  readonly delete: (threadId: string) => Effect.Effect<void, RikaAdapterError>
  readonly fork: (input: {
    readonly threadId: string
    readonly atTurn?: string
  }) => Effect.Effect<Session, RikaAdapterError>
  readonly replyAuthorization: (input: {
    readonly requestId: string
    readonly reply: AuthorizationReply
  }) => Effect.Effect<void, RikaAdapterError>
  readonly dispose: Effect.Effect<void>
}

export type RikaAdapter = {
  readonly catalog: (workspace?: string) => Effect.Effect<RikaCatalogValue, RikaAdapterError>
  readonly login: (input: { readonly provider: "openrouter"; readonly apiKey: string }) =>
    Effect.Effect<void, RikaAdapterError>
  readonly logout: (provider: "openrouter") => Effect.Effect<void, RikaAdapterError>
  readonly directory: (workspace: string) => Effect.Effect<RikaDirectoryRuntime, RikaAdapterError>
  readonly listThreads: Effect.Effect<ReadonlyArray<Session>, RikaAdapterError>
  readonly runtimeForThread: (threadId: string) => Effect.Effect<RikaDirectoryRuntime, RikaAdapterError>
  readonly runtimeForAuthorization: (requestId: string) => Effect.Effect<RikaDirectoryRuntime, RikaAdapterError>
  readonly dispose: Effect.Effect<void>
}

const adapterError = (operation: string, error: unknown) => {
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error)
  return RikaAdapterError.make({ operation, message: `${operation}: ${message}` })
}

const summarySession = (summary: ThreadSummary.ThreadSummary): Session => ({
  id: summary.id,
  slug: `rika-${encodeURIComponent(summary.id)}`,
  projectID: summary.workspace,
  directory: summary.workspace,
  title: summary.title,
  version: "rika",
  time: {
    created: summary.lastActivityAt,
    updated: summary.lastActivityAt,
    ...(summary.archived ? { archived: summary.lastActivityAt } : {}),
  },
  metadata: { pinned: false, summaryStatus: summary.status, unread: summary.unread },
})

const eventThreadId = (event: InteractiveEvent.InteractiveEvent): string | undefined => {
  if (event._tag === "ThreadViewSnapshot") return event.snapshot.thread.id
  if (event._tag === "ThreadViewPatch") return event.patch.threadId
  if ("threadId" in event && typeof event.threadId === "string") return event.threadId
}

const eventId = (workspace: string, revision: number, kind: string, ordinal: number) =>
  `rika-event:${encodeURIComponent(workspace)}:threads:${revision}:${ordinal.toString().padStart(4, "0")}:${kind}`

const runJson = <A, I>(
  connection: ServerService.Connection,
  operation: string,
  input: I,
  schema: Schema.Codec<A, unknown, never, unknown>,
): Effect.Effect<A, RikaAdapterError> =>
  Effect.suspend(() => {
    let output = ""
    return connection
      .run(input as Parameters<ServerService.Connection["run"]>[0], {
        stdout: (text) =>
          Effect.sync(() => {
            output += text
          }),
      })
      .pipe(
        Effect.flatMap(() => Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(output)),
        Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)),
        Effect.mapError((error) => adapterError(operation, error)),
      )
  })

const runCommand = (operation: string, effect: Effect.Effect<void, unknown>): Effect.Effect<void, RikaAdapterError> =>
  effect.pipe(Effect.mapError((error) => adapterError(operation, error)))

const runText = <I>(
  connection: ServerService.Connection,
  operation: string,
  input: I,
): Effect.Effect<string, RikaAdapterError> =>
  Effect.suspend(() => {
    let output = ""
    return connection
      .run(input as Parameters<ServerService.Connection["run"]>[0], {
        stdout: (text) =>
          Effect.sync(() => {
            output += text
          }),
      })
      .pipe(
        Effect.asVoid,
        Effect.map(() => output),
        Effect.mapError((error) => adapterError(operation, error)),
      )
  })

const loadCatalog = (connection: ServerService.Connection, workspace: string) =>
  Effect.gen(function* () {
    const catalog = yield* runJson(
      connection,
      "Config.list",
      { _tag: "Config", action: "list", clientWorkspace: workspace },
      RikaCatalog,
    )
    const provider = catalog.model.route.providerId
    const model = catalog.model.route.model
    if (provider !== "openrouter")
      return yield* RikaAdapterError.make({
        operation: "Config.list",
        message: "Rika desktop supports OpenRouter only",
      })
    if (model !== "openrouter/free" && !model.endsWith(":free"))
      return yield* RikaAdapterError.make({
        operation: "Config.list",
        message: `Rika desktop supports OpenRouter free models only, not ${model}`,
      })
    const status = yield* runText(connection, "Auth.status", {
      _tag: "Auth",
      action: "status",
      provider: "openrouter",
      clientWorkspace: workspace,
    })
    if (!status.includes("API key stored")) return catalog
    return {
      ...catalog,
      environment: {
        ...catalog.environment,
        providerApiKeys: { ...catalog.environment.providerApiKeys, openrouter: "present" as const },
      },
    }
  })

const makeRuntime = Effect.fn("RikaAdapter.makeRuntime")(function* (
  connection: ServerService.Connection,
  workspace: string,
  emit: Emit,
) {
  const commandAdmission = yield* Semaphore.make(1)
  const ready = yield* Deferred.make<InteractiveSession, RikaAdapterError>()
  const projections = new Map<string, ProjectionState>()
  const sessions = new Map<string, Session>()
  let summaryRevision = 0
  let session: InteractiveSession | undefined
  let projectionModel = { providerID: "rika", modelID: "unknown" }
  const runtimeCatalog = loadCatalog(connection, workspace).pipe(
    Effect.tap((catalog) =>
      Effect.sync(() => {
        projectionModel = {
          providerID: catalog.model.route.providerId,
          modelID: catalog.model.route.model,
        }
      }),
    ),
  )

  const emitThreadSessions = (next: ReadonlyArray<Session>) => {
    const events: Event[] = []
    const revision = summaryRevision++
    let ordinal = 0
    const ids = new Set(next.map((item) => item.id))
    for (const [threadId, previous] of sessions) {
      if (ids.has(threadId)) continue
      sessions.delete(threadId)
      projections.delete(threadId)
      events.push({
        id: eventId(workspace, revision, "session.deleted", ordinal++),
        type: "session.deleted",
        properties: { sessionID: threadId, info: previous },
      })
    }
    for (const info of next) {
      const previous = sessions.get(info.id)
      sessions.set(info.id, info)
      if (JSON.stringify(previous) === JSON.stringify(info)) continue
      events.push({
        id: eventId(workspace, revision, "session.updated", ordinal++),
        type: "session.updated",
        properties: { sessionID: info.id, info },
      })
    }
    if (events.length > 0) emit(workspace, events)
  }

  const refreshThreads = (input?: {
    readonly search?: string
    readonly includeArchived?: boolean
    readonly limit?: number
  }) =>
    runJson(
      connection,
      input?.search ? "Thread.search" : "Thread.list",
      input?.search
        ? {
            _tag: "Thread" as const,
            action: "search" as const,
            clientWorkspace: workspace,
            query: input.search.trim().split(/\s+/).filter(Boolean),
            ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }
        : {
            _tag: "Thread" as const,
            action: "list" as const,
            clientWorkspace: workspace,
            ...(input?.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
            ...(input?.limit === undefined ? {} : { limit: input.limit }),
          },
      Schema.Array(Thread.Thread),
    ).pipe(
      Effect.map((threads) =>
        threads.filter((thread) => thread.workspace === workspace).map((thread) => projectThread(thread)),
      ),
      Effect.tap((next) => Effect.sync(() => emitThreadSessions(next))),
    )

  const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
    if (event._tag === "ThreadsListed") {
      emitThreadSessions(event.threads.filter((thread) => thread.workspace === workspace).map(summarySession))
      return
    }
    const threadId = eventThreadId(event)
    if (!threadId) return
    const state = projections.get(threadId) ?? {}
    const translated = translateInteractiveEvent(state, event, projectionModel)
    if (translated._tag === "Failure") {
      if (
        translated.failure instanceof RikaProjectionError &&
        (translated.failure.reason === "invalid-patch" || translated.failure.reason === "resync-required") &&
        session
      )
        Effect.runFork(
          commandAdmission.withPermits(1)(
            session.selectThread(threadId).pipe(Effect.mapError((error) => adapterError("SelectThread", error))),
          ),
        )
      return
    }
    projections.set(threadId, translated.success.state)
    const projected = translated.success.state.projected
    if (projected) sessions.set(threadId, projected.session)
    if (translated.success.events.length > 0) emit(workspace, translated.success.events)
  }

  const feed = Effect.runFork(
    runThreadFeed(connection, { workspace }, (next) =>
      Effect.gen(function* () {
        session = next
        yield* Deferred.succeed(ready, next)
        yield* next.events(dispatch)
      }).pipe(Effect.mapError((error) => adapterError("Interactive.events", error))),
    ).pipe(
      Effect.catch((error) =>
        Deferred.fail(ready, adapterError("Interactive", error)).pipe(
          Effect.andThen(Effect.fail(adapterError("Interactive", error))),
        ),
      ),
    ),
  )

  const withSession = <A>(
    operation: string,
    use: (interactive: InteractiveSession) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, RikaAdapterError> =>
    Deferred.await(ready).pipe(
      Effect.flatMap(use),
      Effect.mapError((error) => adapterError(operation, error)),
    )

  const select = (threadId: string) =>
    commandAdmission.withPermits(1)(withSession("SelectThread", (interactive) => interactive.selectThread(threadId)))

  const mutateThread = (
    operation: string,
    input: Parameters<ServerService.Connection["run"]>[0],
  ): Effect.Effect<void, RikaAdapterError> =>
    runCommand(operation, connection.run(input)).pipe(
      Effect.andThen(refreshThreads({ includeArchived: true })),
      Effect.asVoid,
    )

  const runtime: RikaDirectoryRuntime = {
    workspace,
    ready: Deferred.await(ready),
    catalog: runtimeCatalog,
    listThreads: refreshThreads,
    createThread: runJson(
      connection,
      "Thread.new",
      { _tag: "Thread", action: "new", clientWorkspace: workspace },
      Thread.Thread,
    ).pipe(
      Effect.map(projectThread),
      Effect.tap((created) =>
        Effect.sync(() => emitThreadSessions([...sessions.values(), created])).pipe(Effect.andThen(select(created.id))),
      ),
    ),
    selectThread: select,
    getThread: (threadId) => projections.get(threadId)?.projected?.session ?? sessions.get(threadId),
    getMessages: (threadId) => {
      const projected = projections.get(threadId)?.projected
      if (!projected) return []
      return projected.messages.map((info) => ({
        info,
        parts: projected.parts.filter((part) => part.messageID === info.id),
      }))
    },
    getStatus: (threadId) => projections.get(threadId)?.projected?.status,
    getPermissions: () => [...projections.values()].flatMap((state) => state.projected?.permissions ?? []),
    submit: (input) =>
      commandAdmission.withPermits(1)(
        withSession("Submit", (interactive) =>
          interactive
            .selectThread(Thread.ThreadId.make(input.threadId))
            .pipe(
              Effect.andThen(
                interactive.submit(
                  input.prompt,
                  input.mode,
                  input.promptParts,
                  { ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }) },
                  input.submissionId,
                ),
              ),
            ),
        ),
      ),
    shell: (input) =>
      commandAdmission.withPermits(1)(
        withSession("Shell", (interactive) =>
          interactive
            .selectThread(Thread.ThreadId.make(input.threadId))
            .pipe(
              Effect.andThen(interactive.shell(Thread.ThreadId.make(input.threadId), input.command, input.incognito)),
            ),
        ),
      ),
    cancel: (threadId) =>
      commandAdmission.withPermits(1)(
        withSession("Cancel", (interactive) =>
          interactive.selectThread(threadId).pipe(Effect.andThen(interactive.cancel)),
        ),
      ),
    rename: (input) =>
      mutateThread("Thread.rename", {
        _tag: "Thread",
        action: "rename",
        clientWorkspace: workspace,
        threadId: input.threadId,
        title: input.title,
      }),
    archive: (input) =>
      mutateThread(input.archived ? "Thread.archive" : "Thread.unarchive", {
        _tag: "Thread",
        action: input.archived ? "archive" : "unarchive",
        clientWorkspace: workspace,
        threadId: input.threadId,
      }),
    delete: (threadId) =>
      mutateThread("Thread.delete", {
        _tag: "Thread",
        action: "delete",
        clientWorkspace: workspace,
        threadId,
      }),
    fork: (input) =>
      runJson(
        connection,
        "Thread.fork",
        {
          _tag: "Thread",
          action: "fork",
          clientWorkspace: workspace,
          threadId: input.threadId,
          ...(input.atTurn === undefined ? {} : { atTurn: input.atTurn }),
        },
        Thread.Thread,
      ).pipe(
        Effect.map(projectThread),
        Effect.tap((created) => Effect.sync(() => emitThreadSessions([...sessions.values(), created]))),
      ),
    replyAuthorization: (input) =>
      commandAdmission.withPermits(1)(
        withSession("Authorization.reply", (interactive) => {
          const target = [...projections.values()]
            .map((state) => state.projected?.authorizationIndex.get(input.requestId))
            .find((value) => value !== undefined)
          if (!target)
            return Effect.fail(
              ProductOperation.OperationUnavailable.make({
                operation: "Authorization.reply",
                message: `Authorization ${input.requestId} is not pending`,
              }),
            )
          return interactive
            .selectThread(target.threadId)
            .pipe(
              Effect.andThen(
                input.reply === "once"
                  ? interactive.approveAuthorization(target.turnId, target.authorizationId)
                  : interactive.denyAuthorization(target.turnId, target.authorizationId),
              ),
            )
        }),
      ),
    dispose: Fiber.interrupt(feed),
  }
  return runtime
})

export const makeRikaAdapter = Effect.fn("RikaAdapter.make")(function* (
  connection: ServerService.Connection,
  emit: Emit,
) {
  const runtimes = new Map<string, RikaDirectoryRuntime>()
  const runtimeFibers = yield* Semaphore.make(1)

  const directory = (workspace: string) =>
    runtimeFibers.withPermits(1)(
      Effect.gen(function* () {
        const existing = runtimes.get(workspace)
        if (existing) return existing
        const runtime = yield* makeRuntime(connection, workspace, emit)
        runtimes.set(workspace, runtime)
        return runtime
      }),
    )

  const dispose = Effect.suspend(() =>
    Effect.forEach([...runtimes.values()], (runtime) => runtime.dispose, {
      concurrency: "unbounded",
      discard: true,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          runtimes.clear()
        }),
      ),
    ),
  )

  const catalog = (workspace = "") => loadCatalog(connection, workspace)

  const findRuntime = (
    operation: string,
    predicate: (runtime: RikaDirectoryRuntime) => boolean,
  ): Effect.Effect<RikaDirectoryRuntime, RikaAdapterError> =>
    Effect.suspend(() => {
      const runtime = [...runtimes.values()].find(predicate)
      return runtime
        ? Effect.succeed(runtime)
        : Effect.fail(RikaAdapterError.make({ operation, message: `${operation} target is not cached` }))
    })

  const readAllThreads = () =>
    runJson(
      connection,
      "Thread.list",
      { _tag: "Thread", action: "list", includeArchived: true },
      Schema.Array(Thread.Thread),
    )

  const runtimeForThread = (threadId: string) =>
    Effect.suspend(() => {
      const cached = [...runtimes.values()].find((runtime) => runtime.getThread(threadId) !== undefined)
      if (cached) return Effect.succeed(cached)
      return readAllThreads().pipe(
        Effect.flatMap((threads) => {
          const summary = threads.find((thread) => thread.id === threadId)
          if (!summary)
            return Effect.fail(
              RikaAdapterError.make({ operation: "Thread.lookup", message: `Thread ${threadId} does not exist` }),
            )
          return directory(summary.workspace).pipe(
            Effect.tap((runtime) => runtime.listThreads({ includeArchived: true })),
            Effect.tap((runtime) => runtime.selectThread(threadId)),
          )
        }),
      )
    })
  const runtimeForAuthorization = (requestId: string) =>
    findRuntime("Authorization.lookup", (runtime) =>
      runtime.getPermissions().some((permission) => permission.id === requestId),
    )

  const listThreads = readAllThreads().pipe(Effect.map((threads) => threads.map((thread) => projectThread(thread))))
  const login = (input: { readonly provider: "openrouter"; readonly apiKey: string }) =>
    runCommand(
      "Auth.login",
      connection.run({
        _tag: "Auth",
        action: "login",
        provider: input.provider,
        apiKey: input.apiKey,
      }),
    )
  const logout = (provider: "openrouter") =>
    runCommand("Auth.logout", connection.run({ _tag: "Auth", action: "logout", provider }))

  return {
    catalog,
    directory,
    listThreads,
    login,
    logout,
    runtimeForThread,
    runtimeForAuthorization,
    dispose,
  } satisfies RikaAdapter
})
