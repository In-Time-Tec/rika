/* oxlint-disable typescript/no-unsafe-type-assertion -- Bun's DOM-compatible WebSocket global omits its headers overload. */
/* oxlint-disable effecttsgo/global-fetch -- this is the owning Bun process's Fetch boundary. */
import type { FileCredentialAuth } from "@rika/client/credentials"
import { makeFetchTransport } from "@rika/client/product"
import {
  makeRunnerClient,
  type RunnerClient,
  type RunnerEnrollmentRequest,
  type RunnerPollAssignment,
} from "@rika/client/runner"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import * as ProductOperation from "@rika/product/product-operation"
import {
  runRunnerDaemon,
  type RunnerDaemonError,
  type RunnerDaemonOptions,
  type RunnerDaemonRequirements,
} from "@rika/runner/daemon"
import {
  Installation,
  layer as installationLayer,
  type InstallationRequest,
  type PreparedInstallation,
} from "@rika/tui-v2/src/client/installation"
import { validateRunnerBinding } from "@rika/tui-v2/src/client/runners"
import { Config, Console, Crypto, Effect, Scope } from "effect"
import type { Input as RunnerInput } from "../command/root/runner"
import type { Profile } from "../hosted/contract"
import { gitOutput } from "../platform/git"
import { provideLayerScoped } from "../platform/provide"

const maximumRunnerThreads = 64
const pollInterval = "3 seconds" as const

const unavailable = (message: string) => ProductOperation.OperationUnavailable.make({ operation: "Runner", message })

const asUnavailable = (error: { readonly message: string }) => unavailable(error.message)

const retryDelay = (failures: number) => Math.min(250 * 2 ** Math.min(failures, 5), 5_000)

type BunWebSocketOptions = {
  protocols?: string[]
  headers?: Readonly<Record<string, string>>
}

type BunWebSocketConstructor = new (url: string, options?: BunWebSocketOptions) => globalThis.WebSocket

// SAFETY: the packaged CLI runs under Bun, whose WebSocket constructor accepts the options form below.
const bunWebSocket = globalThis.WebSocket as BunWebSocketConstructor

const connectWebSocket = (request: RunnerEnrollmentRequest) =>
  new bunWebSocket(request.url, { protocols: [...request.protocols], headers: request.headers })

interface SupervisedAssignment {
  assignmentId: string
  readonly scope: Scope.Closeable
}

export interface HeadlessClients {
  readonly profile: Profile
  readonly auth: FileCredentialAuth
}

/**
 * Owns the checkout's supervisor lease and keeps one Runner daemon per admitted Thread. Failed or stopped
 * entries are removed so the next poll can admit them again; the poll's `activeAssignmentIds` carries the raw
 * hosted assignment identities returned by the server, never fenced binding identities.
 */
export const superviseRunnerAssignments = Effect.fn("RikaHeadless.supervise")(function* (options: {
  readonly runner: Pick<RunnerClient, "poll" | "binding" | "enrollmentRequest">
  readonly installation: PreparedInstallation
  readonly supervisorId: string
  readonly startDaemon?: (
    options: RunnerDaemonOptions,
  ) => Effect.Effect<never, RunnerDaemonError, RunnerDaemonRequirements>
}) {
  const parentScope = yield* Effect.scope
  const supervisorScope = yield* Scope.fork(parentScope)
  const platform = yield* Effect.context<RunnerDaemonRequirements>()
  const startDaemon = options.startDaemon ?? runRunnerDaemon
  const supervised = new Map<string, SupervisedAssignment>()
  const expected = {
    workspaceId: options.installation.workspaceIdentity,
    checkoutFingerprint: options.installation.checkoutFingerprint,
    buildId: currentExecutorPolicy.buildId,
    protocolVersion: currentExecutorPolicy.protocolVersion,
  }

  const serve = (assignment: RunnerPollAssignment) =>
    options.runner.binding(assignment.threadId).pipe(
      Effect.flatMap((binding) => validateRunnerBinding(options.installation, binding, currentExecutorPolicy)),
      Effect.andThen(
        startDaemon({
          checkout: options.installation.workspacePath,
          threadId: assignment.threadId,
          expected,
          client: options.runner,
          connect: connectWebSocket,
          onReady: Console.log(`Serving Thread ${assignment.threadId}`),
        }),
      ),
      Effect.tapError((error) => Console.log(`Stopped serving Thread ${assignment.threadId}: ${error.message}`)),
      Effect.ensuring(
        Effect.sync(() => {
          supervised.delete(assignment.threadId)
        }),
      ),
    )

  const ensure = Effect.fn("RikaHeadless.ensure")(function* (assignment: RunnerPollAssignment) {
    const existing = supervised.get(assignment.threadId)
    if (existing !== undefined) {
      existing.assignmentId = assignment.assignmentId
      return "supervised" as const
    }
    if (supervised.size >= maximumRunnerThreads) return "capacity" as const
    const scope = yield* Scope.fork(supervisorScope)
    supervised.set(assignment.threadId, { assignmentId: assignment.assignmentId, scope })
    yield* Effect.forkIn(serve(assignment).pipe(Effect.provide(platform)), scope, { startImmediately: true })
    return "started" as const
  })

  const activeAssignmentIds = () => [...supervised.values()].map((entry) => entry.assignmentId)
  let unowned = false
  let capacityNotice = false
  let failures = 0
  while (true) {
    const polled = yield* Effect.result(
      options.runner.poll({
        checkoutFingerprint: options.installation.checkoutFingerprint,
        supervisorId: options.supervisorId,
        activeAssignmentIds: activeAssignmentIds(),
      }),
    )
    if (polled._tag === "Failure") {
      if (polled.failure.kind !== "network") return yield* unavailable(polled.failure.message)
      yield* Console.log(`Runner poll failed: ${polled.failure.message}; reconnecting`)
      yield* Effect.sleep(retryDelay(failures))
      failures = Math.min(failures + 1, 31)
      continue
    }
    failures = 0
    const result = polled.success
    if (!result.claimed) {
      if (!unowned) yield* Console.log("Another Rika process owns this Runner checkout; waiting to serve")
      unowned = true
      yield* Effect.sleep(pollInterval)
      continue
    }
    if (unowned) {
      unowned = false
      yield* Console.log("Runner owns this checkout again")
    }
    const assignment = result.assignment
    if (assignment === null) {
      capacityNotice = false
      yield* Effect.sleep(pollInterval)
      continue
    }
    if ((yield* ensure(assignment)) === "capacity") {
      if (!capacityNotice)
        yield* Console.log(`Runner is already serving ${maximumRunnerThreads} Threads; waiting for a free slot`)
      capacityNotice = true
      yield* Effect.sleep(pollInterval)
      continue
    }
    capacityNotice = false
  }
})

export const runHeadlessWithClients = Effect.fn("RikaHeadless.run")(function* (
  input: RunnerInput,
  clients: HeadlessClients,
) {
  const requestHeaders = clients.auth.requestHeaders
  if (requestHeaders === undefined)
    return yield* unavailable("HTTP credentials were not provided by the authenticated client")
  const runner = makeRunnerClient({
    baseUrl: clients.profile.origin,
    transport: makeFetchTransport((request) => globalThis.fetch(request)),
    requestHeaders,
  })
  const workspace = input.workspace ?? process.cwd()
  const root = (yield* gitOutput(workspace, ["rev-parse", "--show-toplevel"])) ?? workspace
  const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
  const installation = yield* Effect.gen(function* () {
    const installations = yield* Installation
    const request: InstallationRequest = { deviceId: clients.auth.deviceId, workspace: root }
    if (clients.profile.project !== undefined) Object.assign(request, { projectId: clients.profile.project })
    return yield* installations.prepare(request)
  }).pipe(provideLayerScoped(installationLayer({ home })), Effect.mapError(asUnavailable))
  yield* runner
    .register({ checkoutFingerprint: installation.checkoutFingerprint, profile: installation.profile })
    .pipe(Effect.mapError(asUnavailable))
  yield* Console.log(`Registered Runner checkout ${installation.workspacePath}`)
  if (input.remoteThreadCreation !== undefined)
    yield* runner
      .setRemoteThreadCreation({
        checkoutFingerprint: installation.checkoutFingerprint,
        preference: input.remoteThreadCreation,
      })
      .pipe(Effect.mapError(asUnavailable))
  const crypto = yield* Crypto.Crypto
  const supervisorId = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => unavailable("Could not allocate a supervisor identity")),
  )
  return yield* Effect.scoped(superviseRunnerAssignments({ runner, installation, supervisorId })).pipe(
    Effect.onExit(() => Console.log("Runner stopped")),
  )
})
