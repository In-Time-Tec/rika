import type { RunnerClient, RunnerEnrollmentRequest } from "@rika/client/runner"
import { ProductClientError } from "@rika/client/product"
import {
  ExecutorFenceError,
  ExecutorTransportError,
  WorkspaceExecutor,
  sameBinding,
  type WorkspaceBinding,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { Context, Effect, Exit, FileSystem, Layer, Path, Ref, Schema, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

import { connectRunnerWebSocket } from "./transport"
import { RunnerWorkspaceError } from "./errors"
import { localWorkspaceExecutorLayer } from "./workspace"

export interface RunnerDaemonExpected {
  readonly workspaceId: string
  readonly checkoutFingerprint: string
  readonly buildId: string
  readonly protocolVersion: number
}

export interface RunnerDaemonOptions {
  readonly checkout: string
  readonly threadId: string
  readonly expected: RunnerDaemonExpected
  readonly client: Pick<RunnerClient, "binding" | "enrollmentRequest">
  readonly connect: (request: RunnerEnrollmentRequest) => globalThis.WebSocket
  readonly onReady?: Effect.Effect<void>
}

export type RunnerDaemonError = ProductClientError | ExecutorFenceError | ExecutorTransportError | RunnerWorkspaceError

export type RunnerDaemonRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

interface ActiveExecutor {
  readonly scope: Scope.Closeable
  readonly workspace: WorkspaceExecutorService
}

interface DaemonState {
  readonly binding?: WorkspaceBinding
  readonly active?: ActiveExecutor
}

const reconnectInitialDelayMillis = 250
const reconnectMaximumDelayMillis = 5_000
const enrollmentTimeout = "10 seconds"

const fence = (reason: ExecutorFenceError["reason"], message: string) => ExecutorFenceError.make({ reason, message })

const transport = (message: string) => ExecutorTransportError.make({ phase: "connection", message })

const validateBinding = (
  expected: RunnerDaemonExpected,
  binding: WorkspaceBinding,
): Effect.Effect<WorkspaceBinding, ExecutorFenceError> => {
  if (binding.workspaceId !== expected.workspaceId)
    return Effect.fail(fence("workspace", "Runner binding does not match the expected workspace"))
  if (binding.placement._tag !== "Runner")
    return Effect.fail(fence("placement", "Runner binding has an incompatible placement"))
  if (binding.placement.workspaceId !== binding.workspaceId)
    return Effect.fail(fence("workspace", "Runner binding placement has a different workspace identity"))
  if (binding.placement.checkoutFingerprint !== expected.checkoutFingerprint)
    return Effect.fail(fence("placement", "Runner binding does not match the expected checkout"))
  if (binding.buildId !== expected.buildId)
    return Effect.fail(fence("build", "Runner binding does not match the expected executor build"))
  if (binding.protocolVersion !== expected.protocolVersion)
    return Effect.fail(fence("protocol", "Runner binding does not match the expected protocol"))
  return Effect.succeed(binding)
}

const validateReplacement = (
  previous: WorkspaceBinding,
  next: WorkspaceBinding,
): Effect.Effect<void, ExecutorFenceError> => {
  if (next.generation <= previous.generation)
    return Effect.fail(fence("generation", "Runner binding replacement did not advance the generation"))
  if (next.assignmentId === previous.assignmentId)
    return Effect.fail(fence("assignment", "Runner binding replacement reused the previous assignment"))
  return Effect.void
}

const retryable = (error: RunnerDaemonError): boolean =>
  Schema.is(ExecutorTransportError)(error) || (Schema.is(ProductClientError)(error) && error.kind === "network")

const retryDelay = (failures: number): number =>
  Math.min(reconnectInitialDelayMillis * 2 ** failures, reconnectMaximumDelayMillis)

export const runRunnerDaemon = (
  options: RunnerDaemonOptions,
): Effect.Effect<never, RunnerDaemonError, RunnerDaemonRequirements> =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Ref.make<DaemonState>({})

      const closeActive = (active: ActiveExecutor | undefined) =>
        active === undefined ? Effect.void : Scope.close(active.scope, Exit.void)

      yield* Effect.addFinalizer(() =>
        Ref.getAndSet(state, {}).pipe(Effect.flatMap((current) => closeActive(current.active))),
      )

      const reconcileBinding = (binding: WorkspaceBinding) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (current.binding === undefined) {
              yield* Ref.set(state, { binding })
              return
            }
            if (sameBinding(current.binding, binding)) return
            yield* validateReplacement(current.binding, binding)
            yield* Ref.set(state, { binding })
            yield* closeActive(current.active)
          }),
        )

      const executorFor = (binding: WorkspaceBinding) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (current.binding === undefined || !sameBinding(current.binding, binding))
              return yield* fence("generation", "Runner binding changed before executor acquisition")
            if (current.active !== undefined) return current.active.workspace
            const scope = yield* Scope.make()
            const built = yield* restore(
              Layer.build(localWorkspaceExecutorLayer({ checkout: options.checkout, binding })).pipe(
                Scope.provide(scope),
              ),
            ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)))
            const workspace = Context.get(built, WorkspaceExecutor)
            yield* Ref.set(state, { binding, active: { scope, workspace } })
            return workspace
          }),
        )

      const connectOnce = Effect.gen(function* () {
        const binding = yield* options.client
          .binding(options.threadId)
          .pipe(Effect.flatMap((candidate) => validateBinding(options.expected, candidate)))
        yield* reconcileBinding(binding)
        const request = yield* options.client.enrollmentRequest(options.threadId)
        const workspace = yield* executorFor(binding)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connectRunnerWebSocket({
              workspace,
              connect: () => options.connect(request),
            })
            yield* connection.ready.pipe(
              Effect.timeoutOrElse({
                duration: enrollmentTimeout,
                orElse: () => Effect.fail(transport("Runner WebSocket enrollment timed out")),
              }),
            )
            if (options.onReady !== undefined) yield* options.onReady
            yield* connection.closed
          }),
        )
      })

      const loop = (failures: number): Effect.Effect<never, RunnerDaemonError, RunnerDaemonRequirements> =>
        Effect.result(connectOnce).pipe(
          Effect.flatMap((result) => {
            if (result._tag === "Failure" && !retryable(result.failure)) return Effect.fail(result.failure)
            const delay = retryDelay(result._tag === "Success" ? 0 : failures)
            const nextFailures = result._tag === "Success" ? 0 : Math.min(failures + 1, 31)
            return Effect.sleep(delay).pipe(Effect.andThen(Effect.suspend(() => loop(nextFailures))))
          }),
        )

      return yield* loop(0)
    }),
  )
