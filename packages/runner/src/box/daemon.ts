import { BoxBootstrapDocument } from "@rika/box-executor/bootstrap"
import { OrbWorkspaceBinding } from "@rika/box-executor/contract"
import {
  ExecutorFenceError,
  ExecutorTransportError,
  WorkspaceExecutor,
  workspaceExecutorWebSocketProtocol,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { Clock, Context, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

import { RunnerWorkspaceError } from "../errors"
import { connectRunnerWebSocket } from "../transport"
import { localWorkspaceExecutorLayer } from "../workspace"

export interface BoxExecutorExpected {
  readonly buildId: string
  readonly protocolVersion: number
}

export interface BoxExecutorOptions {
  readonly bootstrap: BoxBootstrapDocument
  readonly expected: BoxExecutorExpected
  readonly connect: (url: string, protocol: string, headers: Readonly<Record<string, string>>) => globalThis.WebSocket
}

export class BoxExecutorError extends Schema.TaggedError<BoxExecutorError>()("RikaRunnerV2BoxExecutorError", {
  kind: Schema.Literals(["bootstrap", "credentials", "url", "workspace"]),
  message: Schema.String,
}) {}

export type BoxExecutorFailure = BoxExecutorError | ExecutorFenceError | ExecutorTransportError | RunnerWorkspaceError

export type BoxExecutorRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

interface ValidatedBootstrap {
  readonly value: BoxBootstrapDocument
  readonly workspace: OrbWorkspaceBinding
  readonly url: string
  readonly ticket: Redacted.Redacted<string>
}

const enrollmentLifetimeMillis = 300_000
const enrollmentTimeout = "10 seconds"
const ticketPattern = /^[A-Za-z0-9_-]{43}$/

const failure = (kind: BoxExecutorError["kind"], message: string) => BoxExecutorError.make({ kind, message })

const fence = (reason: ExecutorFenceError["reason"], message: string) => ExecutorFenceError.make({ reason, message })

const transport = (phase: ExecutorTransportError["phase"], message: string) =>
  ExecutorTransportError.make({ phase, message })

const validateUrl = (boxId: string, input: string): Effect.Effect<string, BoxExecutorError> =>
  Effect.try({
    try: () => {
      const url = new URL(input)
      if (
        (url.protocol !== "ws:" && url.protocol !== "wss:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        url.pathname !== `/api/v2/boxes/${encodeURIComponent(boxId)}/executor` ||
        url.href !== input
      )
        throw new Error("invalid Box enrollment URL")
      return url.href
    },
    catch: () => failure("url", "Box enrollment URL is invalid"),
  })

const validateTicket = (expiresAtMillis: number, ticket: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      ticketPattern.test(ticket) && expiresAtMillis > now && expiresAtMillis <= now + enrollmentLifetimeMillis
        ? Effect.succeed(Redacted.make(ticket))
        : Effect.fail(failure("credentials", "Box enrollment credentials are invalid or expired")),
    ),
  )

const validateBootstrap = (options: BoxExecutorOptions) =>
  Effect.gen(function* () {
    const bootstrap = yield* Schema.decodeEffect(BoxBootstrapDocument)(options.bootstrap).pipe(
      Effect.mapError(() => failure("bootstrap", "Box bootstrap document is invalid")),
    )
    const workspace = yield* Schema.decodeUnknownEffect(OrbWorkspaceBinding)(bootstrap.binding).pipe(
      Effect.mapError(() => fence("placement", "Box bootstrap binding is not assigned to an Orb")),
    )
    if (workspace.workspaceId !== workspace.placement.workspaceId)
      return yield* fence("workspace", "Box bootstrap binding has inconsistent workspace identity")
    if (workspace.buildId !== options.expected.buildId)
      return yield* fence("build", "Box bootstrap binding does not match the executable build")
    if (workspace.protocolVersion !== options.expected.protocolVersion)
      return yield* fence("protocol", "Box bootstrap binding does not match the executable protocol")
    const url = yield* validateUrl(bootstrap.boxId, bootstrap.enrollment.url)
    const ticket = yield* validateTicket(bootstrap.enrollment.expiresAtMillis, bootstrap.enrollment.ticket)
    const path = yield* Path.Path
    if (!path.isAbsolute(bootstrap.workspacePath) || bootstrap.workspacePath.includes("\u0000"))
      return yield* failure("workspace", "Box workspace path must be an absolute path")
    return { value: bootstrap, workspace, url, ticket } satisfies ValidatedBootstrap
  })

export const runBoxExecutor = (
  options: BoxExecutorOptions,
): Effect.Effect<never, BoxExecutorFailure, BoxExecutorRequirements> =>
  Effect.scoped(
    Effect.gen(function* () {
      const validated = yield* validateBootstrap(options)
      const executorScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(executorScope, Exit.void))
      const built = yield* Layer.build(
        localWorkspaceExecutorLayer({ checkout: validated.value.workspacePath, binding: validated.workspace }),
      ).pipe(Scope.provide(executorScope))
      const workspace: WorkspaceExecutorService = Context.get(built, WorkspaceExecutor)
      yield* validateTicket(validated.value.enrollment.expiresAtMillis, Redacted.value(validated.ticket))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connectRunnerWebSocket({
            workspace,
            connect: () =>
              options.connect(validated.url, workspaceExecutorWebSocketProtocol, {
                authorization: `Bearer ${Redacted.value(validated.ticket)}`,
              }),
          })
          yield* connection.ready.pipe(
            Effect.timeoutOrElse({
              duration: enrollmentTimeout,
              orElse: () => Effect.fail(transport("connection", "Box Executor enrollment timed out")),
            }),
          )
          yield* connection.closed
        }),
      )
      return yield* transport("reconnect", "Box Executor connection closed; a fresh bootstrap process is required")
    }),
  )
