import type { ProductClientError, ThreadMetadata } from "@rika/client/product"
import type { RunnerClient, RunnerEnrollmentRequest } from "@rika/client/runner"
import { ThreadClientError } from "@rika/client/thread"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import {
  runRunnerDaemon,
  type RunnerDaemonError,
  type RunnerDaemonOptions,
  type RunnerDaemonRequirements,
} from "@rika/runner/daemon"
import { Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore } from "effect"
import type { PreparedInstallation } from "./installation"

const maximumRunnerThreads = 64

interface RunnerBinding {
  readonly workspaceId: string
  readonly buildId: string
  readonly protocolVersion: number
  readonly placement:
    | { readonly _tag: "Runner"; readonly workspaceId: string; readonly checkoutFingerprint: string }
    | { readonly _tag: "Orb"; readonly workspaceId: string }
}

export interface RunnerExecutorPolicy {
  readonly buildId: string
  readonly protocolVersion: number
}

export const validateRunnerBinding = Effect.fn("TuiV2.Runners.validateBinding")(function* (
  installation: PreparedInstallation,
  binding: RunnerBinding,
  policy: RunnerExecutorPolicy,
) {
  if (binding.workspaceId !== installation.workspaceIdentity)
    return yield* ThreadClientError.make({
      kind: "protocol",
      operation: "runner.binding",
      message: "Runner binding does not match the installed workspace identity",
    })
  if (
    binding.placement._tag !== "Runner" ||
    binding.placement.workspaceId !== binding.workspaceId ||
    binding.placement.checkoutFingerprint !== installation.checkoutFingerprint
  )
    return yield* ThreadClientError.make({
      kind: "protocol",
      operation: "runner.binding",
      message: "Runner binding does not match the installed checkout",
    })
  if (binding.buildId !== policy.buildId)
    return yield* ThreadClientError.make({
      kind: "protocol",
      operation: "runner.binding",
      message: "Runner binding requires an unsupported executor build",
    })
  if (binding.protocolVersion !== policy.protocolVersion)
    return yield* ThreadClientError.make({
      kind: "protocol",
      operation: "runner.binding",
      message: "Runner binding requires an unsupported executor protocol",
    })
  return binding
})

type StartRunnerDaemon = (
  options: RunnerDaemonOptions,
) => Effect.Effect<never, RunnerDaemonError, RunnerDaemonRequirements>

interface RunnerToken {
  readonly threadId: string
}

interface RunnerHandle {
  readonly token: RunnerToken
  readonly ready: Deferred.Deferred<void, ThreadClientError>
  readonly scope: Scope.Closeable
  fiber: Fiber.Fiber<never, ThreadClientError> | undefined
}

interface StartingRunner {
  readonly _tag: "Starting"
  readonly handle: RunnerHandle
}

interface ReadyRunner {
  readonly _tag: "Ready"
  readonly handle: RunnerHandle
}

interface FailedRunner {
  readonly _tag: "Failed"
  readonly handle: RunnerHandle
  readonly error: ThreadClientError
}

type RunnerEntry = StartingRunner | ReadyRunner | FailedRunner

export interface RunnerSupervisorOptions {
  readonly installation: PreparedInstallation
  readonly client: Pick<RunnerClient, "binding" | "enrollmentRequest">
  readonly connect: (request: RunnerEnrollmentRequest) => globalThis.WebSocket
  readonly policy?: RunnerExecutorPolicy
  readonly maxThreads?: number
  readonly startDaemon?: StartRunnerDaemon
}

export interface RunnerSupervisor {
  readonly ensure: (thread: ThreadMetadata) => Effect.Effect<void, ThreadClientError>
  readonly dispose: Effect.Effect<void>
}

const clientError = (operation: string, error: ProductClientError) =>
  ThreadClientError.make({ kind: error.kind, operation, message: error.message })

const daemonError = (error: RunnerDaemonError) => {
  if (error._tag === "RikaClientV2ProductError") return clientError("runner.daemon", error)
  if (error._tag === "RikaExecutionV2ExecutorTransportError")
    return ThreadClientError.make({ kind: "network", operation: "runner.daemon", message: error.message })
  if (error._tag === "RikaExecutionV2ExecutorFenceError")
    return ThreadClientError.make({ kind: "conflict", operation: "runner.daemon", message: error.message })
  return ThreadClientError.make({ kind: "protocol", operation: "runner.daemon", message: error.message })
}

const closedError = () =>
  ThreadClientError.make({ kind: "closed", operation: "runner.ensure", message: "Runner supervisor is closed" })

const overflowError = (capacity: number) =>
  ThreadClientError.make({
    kind: "conflict",
    operation: "runner.ensure",
    message: `This TUI can keep at most ${capacity} local Runner Threads active.`,
  })

export const runnerSupervisor = Effect.fn("TuiV2.Runners.supervisor")(function* (options: RunnerSupervisorOptions) {
  const rootScope = yield* Effect.scope
  const supervisorScope = yield* Scope.fork(rootScope)
  const platform = yield* Effect.context<RunnerDaemonRequirements>()
  const entries = yield* Ref.make(new Map<string, RunnerEntry>())
  const closed = yield* Ref.make(false)
  const lock = yield* Semaphore.make(1)
  const policy = options.policy ?? currentExecutorPolicy
  const capacity = options.maxThreads ?? maximumRunnerThreads
  const startDaemon = options.startDaemon ?? runRunnerDaemon

  const markReady = (threadId: string, token: RunnerToken) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return
        const current = (yield* Ref.get(entries)).get(threadId)
        if (current === undefined || current.handle.token !== token || current._tag !== "Starting") return
        const next = new Map(yield* Ref.get(entries))
        next.set(threadId, { _tag: "Ready", handle: current.handle })
        yield* Ref.set(entries, next)
        yield* Deferred.succeed(current.handle.ready, undefined)
      }),
    )

  const markFailed = (threadId: string, token: RunnerToken, error: ThreadClientError) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* Ref.get(entries)).get(threadId)
        if (current === undefined || current.handle.token !== token || current._tag === "Failed") return
        const next = new Map(yield* Ref.get(entries))
        next.set(threadId, { _tag: "Failed", handle: current.handle, error })
        yield* Ref.set(entries, next)
        yield* Deferred.fail(current.handle.ready, error)
      }),
    )

  const run = (thread: ThreadMetadata, entry: StartingRunner) => {
    const expected = {
      workspaceId: options.installation.workspaceIdentity,
      checkoutFingerprint: options.installation.checkoutFingerprint,
      buildId: policy.buildId,
      protocolVersion: policy.protocolVersion,
    }
    const onReady = markReady(thread.id, entry.handle.token)
    return options.client.binding(thread.id).pipe(
      Effect.mapError((error) => clientError("runner.binding", error)),
      Effect.flatMap((binding) => validateRunnerBinding(options.installation, binding, policy)),
      Effect.andThen(
        startDaemon({
          checkout: options.installation.workspacePath,
          threadId: thread.id,
          expected,
          client: options.client,
          connect: options.connect,
          onReady,
        }).pipe(Effect.mapError(daemonError)),
      ),
      Effect.tapError((error) => markFailed(thread.id, entry.handle.token, error)),
    )
  }

  const awaitEntry = (entry: RunnerEntry): Effect.Effect<void, ThreadClientError> =>
    entry._tag === "Failed" ? Effect.fail(entry.error) : Deferred.await(entry.handle.ready)

  const ensure = Effect.fn("TuiV2.Runners.ensure")(function* (thread: ThreadMetadata) {
    if (thread.target === "orb") return
    const reserved = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return yield* closedError()
        const current = (yield* Ref.get(entries)).get(thread.id)
        if (current !== undefined) return { entry: current, started: false as const }
        if ((yield* Ref.get(entries)).size >= capacity) return yield* overflowError(capacity)
        const entry: StartingRunner = {
          _tag: "Starting",
          handle: {
            token: { threadId: thread.id },
            ready: yield* Deferred.make<void, ThreadClientError>(),
            scope: yield* Scope.fork(supervisorScope),
            fiber: undefined,
          },
        }
        const next = new Map(yield* Ref.get(entries))
        next.set(thread.id, entry)
        yield* Ref.set(entries, next)
        return { entry, started: true as const }
      }),
    )
    if (reserved.started) {
      const fiber = yield* Effect.forkIn(
        run(thread, reserved.entry).pipe(Effect.provide(platform)),
        reserved.entry.handle.scope,
        {
          startImmediately: true,
        },
      )
      reserved.entry.handle.fiber = fiber
    }
    return yield* awaitEntry(reserved.entry)
  })

  const emptyEntries: ReadonlyArray<RunnerEntry> = []
  const dispose = Effect.fn("TuiV2.Runners.dispose")(function* () {
    const current = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return emptyEntries
        yield* Ref.set(closed, true)
        return [...(yield* Ref.get(entries)).values()]
      }),
    )
    const error = closedError()
    yield* Effect.forEach(current, (entry) => Deferred.fail(entry.handle.ready, error), { discard: true })
    yield* Scope.close(supervisorScope, Exit.void)
  })

  return { ensure, dispose: dispose() } satisfies RunnerSupervisor
})
