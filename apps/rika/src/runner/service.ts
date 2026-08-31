import { ForegroundRunnerError, runForegroundRunner, foregroundRunnerLayer } from "@rika/remote-execution/foreground"
import { Config, Console, Context, Crypto, Deferred, Effect, Function, Layer, Option, Path, Ref, Schema } from "effect"
import type { Success } from "effect/Effect"
import { ProjectId } from "@rika/product/hosted-model"
import { inspectRunnerCheckout } from "./checkout"
import { RunnerAdmission, RunnerError, type RunnerStatus, type RemoteThreadCreation } from "./contract"
import * as Preference from "./preference"
import * as RunnerReceiptStore from "./receipt-store"
import { CredentialStore, HostedError, Http, ProfileStore, type Profile } from "../hosted/contract"
import { authenticated, selectedProfile } from "../hosted/account"
import { reconnectDelay, retryableConnectionFailure } from "../hosted/reconnect-policy"

const statusLine = (status: RunnerStatus) => {
  if (status._tag === "Registering")
    return `Registering Runner ${status.registration.workspaceIdentity} for device ${status.registration.deviceId}`
  if (status._tag === "Ready") return `Runner ready ${status.workspaceIdentity}`
  if (status._tag === "Waiting") return `Waiting for Runner: ${status.message}.`
  if (status._tag === "Connecting") return `Connecting Runner ${status.workspaceIdentity}`
  if (status._tag === "Connected") return `Runner connected ${status.workspaceIdentity}`
  return "Runner stopped"
}

const runnerProfile = (registration: Parameters<RunnerAdmission["Service"]["awaitAdmission"]>[0], profile: Profile) => {
  const result = {
    protocolVersion: registration.protocolVersion,
    workspaceIdentity: registration.workspaceIdentity,
    repository: registration.repository,
    kernel: registration.kernel,
    capabilities: registration.capabilities,
  }
  return profile.project === undefined ? result : { ...result, projectId: ProjectId.make(profile.project) }
}

const admissionError = (message: string) => RunnerError.make({ message })
const mapAdmissionError = (error: RunnerError | HostedError) =>
  Schema.is(RunnerError)(error) ? error : admissionError(error.message)

export const liveAdmissionLayer = Layer.effect(
  RunnerAdmission,
  Effect.gen(function* () {
    const http = yield* Http
    const credentials = yield* CredentialStore
    const profiles = yield* ProfileStore
    const register = Effect.fn("Runner.register")(function* (
      registration: Parameters<RunnerAdmission["Service"]["awaitAdmission"]>[0],
    ) {
      const profile = yield* selectedProfile()
      if (profile.deviceId !== registration.deviceId)
        return yield* admissionError("The authenticated device does not own this Runner checkout")
      yield* authenticated(profile, (session) =>
        http.registerRunner(
          profile.origin,
          registration.checkoutFingerprint,
          runnerProfile(registration, profile),
          session,
        ),
      )
      return profile
    })
    return RunnerAdmission.of({
      awaitAdmission: (registration, supervisorId, status, activeAssignmentIds) =>
        Effect.gen(function* () {
          const waitForReconnect = (error: HostedError, attempt: number) => {
            const delay = reconnectDelay(
              error.retryAfterMillis === undefined
                ? { attempt }
                : { attempt, retryAfterMillis: error.retryAfterMillis },
            )
            const reconnect = {
              "rika.failure.category": error.kind === "rate-limit" ? "rate_limited" : "dependency_unavailable",
              "rika.reconnect.attempt": attempt + 1,
              "rika.reconnect.delay.ms": delay,
            }
            const statusAnnotations =
              error.status === undefined ? reconnect : { ...reconnect, "rika.http.status": error.status }
            const annotations =
              error.retryAfterMillis === undefined
                ? statusAnnotations
                : { ...statusAnnotations, "rika.retry_after.ms": error.retryAfterMillis }
            return status({ _tag: "Waiting", message: "the service is reconnecting" }).pipe(
              Effect.andThen(Effect.logInfo("runner.reconnect.scheduled").pipe(Effect.annotateLogs(annotations))),
              Effect.andThen(Effect.sleep(delay)),
            )
          }
          let profile: Profile | undefined
          let registrationFailures = 0
          while (profile === undefined) {
            const synchronized = yield* Effect.result(
              Effect.gen(function* () {
                const selected = yield* register(registration)
                yield* authenticated(selected, (session) =>
                  http.setRemoteThreadCreation(
                    selected.origin,
                    registration.checkoutFingerprint,
                    registration.remoteThreadCreation,
                    session,
                  ),
                )
                return selected
              }),
            )
            if (synchronized._tag === "Success") {
              profile = synchronized.success
              break
            }
            if (!Schema.is(HostedError)(synchronized.failure) || !retryableConnectionFailure(synchronized.failure))
              return yield* synchronized.failure
            yield* waitForReconnect(synchronized.failure, registrationFailures)
            registrationFailures += 1
          }
          yield* status({ _tag: "Ready", workspaceIdentity: registration.workspaceIdentity })
          let waitingReason: "no-work" | "runner-owned" | undefined
          let pollFailures = 0
          while (true) {
            const polled = yield* Effect.result(
              Effect.flatMap(activeAssignmentIds, (active) =>
                authenticated(profile, (session) =>
                  http.pollRunner(profile.origin, registration.checkoutFingerprint, supervisorId, active, session),
                ),
              ),
            )
            if (polled._tag === "Failure") {
              if (!Schema.is(HostedError)(polled.failure) || !retryableConnectionFailure(polled.failure))
                return yield* polled.failure
              yield* waitForReconnect(polled.failure, pollFailures)
              pollFailures += 1
              continue
            }
            pollFailures = 0
            const result = polled.success
            if (result._tag !== "Waiting") return result
            if (waitingReason !== result.reason) {
              waitingReason = result.reason
              yield* status({
                _tag: "Waiting",
                message:
                  result.reason === "runner-owned"
                    ? "another Rika process owns this Runner checkout"
                    : "the Thread has no admitted Runner work yet",
              })
            }
            yield* Effect.sleep("1 second")
          }
        }).pipe(
          Effect.provideService(Http, http),
          Effect.provideService(CredentialStore, credentials),
          Effect.provideService(ProfileStore, profiles),
          Effect.mapError(mapAdmissionError),
        ),
      setRemoteThreadCreation: (registration, preference) =>
        Effect.gen(function* () {
          const profile = yield* register(registration)
          yield* authenticated(profile, (session) =>
            http.setRemoteThreadCreation(profile.origin, registration.checkoutFingerprint, preference, session),
          )
        }).pipe(
          Effect.provideService(Http, http),
          Effect.provideService(CredentialStore, credentials),
          Effect.provideService(ProfileStore, profiles),
          Effect.mapError(mapAdmissionError),
        ),
    })
  }),
)

export type PreparedRunnerCheckout = {
  readonly profile: Profile
  readonly checkout: Success<ReturnType<typeof inspectRunnerCheckout>>
}

const InheritedPreparation = Context.Reference<PreparedRunnerCheckout | undefined>("@rika/cli/RunnerPreparation", {
  defaultValue: () => undefined,
})

const prepareRunnerCheckoutOnce = Effect.fn("Runner.prepareCheckoutOnce")(function* (input: {
  readonly workspace: string
  readonly preferencePath: string
  readonly requestedPreference?: RemoteThreadCreation | undefined
}) {
  const profiles = yield* ProfileStore
  const admission = yield* RunnerAdmission
  const profile = yield* profiles.load
  if (Option.isNone(profile)) return yield* RunnerError.make({ message: "Run rika auth login first" })
  const preferences = yield* Preference.make(input.preferencePath)
  const initial = yield* inspectRunnerCheckout({
    deviceId: profile.value.deviceId,
    workspace: input.workspace,
    remoteThreadCreation: "denied",
  }).pipe(Effect.mapError(() => RunnerError.make({ message: "Could not inspect the local checkout" })))
  const stored = yield* preferences.get(profile.value.deviceId, initial.registration.checkoutFingerprint)
  const preference = input.requestedPreference ?? stored
  const checkout =
    preference === initial.registration.remoteThreadCreation
      ? initial
      : yield* inspectRunnerCheckout({
          deviceId: profile.value.deviceId,
          workspace: input.workspace,
          remoteThreadCreation: preference,
        }).pipe(Effect.mapError(() => RunnerError.make({ message: "Could not inspect the local checkout" })))
  yield* admission.setRemoteThreadCreation(checkout.registration, preference)
  if (input.requestedPreference !== undefined) {
    yield* preferences.set(profile.value.deviceId, checkout.registration.checkoutFingerprint, preference)
  }
  return { profile: profile.value, checkout }
})

export const prepareRunnerCheckout = Effect.fn("Runner.prepareCheckout")(function* (
  input: Parameters<typeof prepareRunnerCheckoutOnce>[0],
) {
  const prepared = yield* InheritedPreparation
  return prepared ?? (yield* prepareRunnerCheckoutOnce(input))
})

const withPreparedRunnerCheckoutImpl = <A, E, R>(
  input: Parameters<typeof prepareRunnerCheckoutOnce>[0],
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(prepareRunnerCheckoutOnce(input), (prepared) =>
    Effect.provideService(operation, InheritedPreparation, prepared),
  )

export const withPreparedRunnerCheckout: {
  <A, E, R>(
    input: Parameters<typeof prepareRunnerCheckoutOnce>[0],
    operation: Effect.Effect<A, E, R>,
  ): ReturnType<typeof withPreparedRunnerCheckoutImpl<A, E, R>>
  (
    input: Parameters<typeof prepareRunnerCheckoutOnce>[0],
  ): <A, E, R>(operation: Effect.Effect<A, E, R>) => ReturnType<typeof withPreparedRunnerCheckoutImpl<A, E, R>>
} = Function.dual(2, withPreparedRunnerCheckoutImpl)

export const runRunner = Effect.fn("Runner.run")(function* (
  input: {
    readonly workspace: string
    readonly preferencePath: string
    readonly requestedPreference?: RemoteThreadCreation | undefined
  },
  prepared?: PreparedRunnerCheckout,
  firstConnection?: Deferred.Deferred<void>,
) {
  const { profile, checkout } = prepared ?? (yield* prepareRunnerCheckout(input))
  const admission = yield* RunnerAdmission
  const crypto = yield* Crypto.Crypto
  const path = yield* Path.Path
  const supervisorId = yield* crypto.randomUUIDv4
  const report = (status: RunnerStatus) =>
    (status._tag === "Ready" && firstConnection !== undefined
      ? Deferred.succeed(firstConnection, undefined)
      : Effect.void
    ).pipe(Effect.andThen(Console.log(statusLine(status))))
  const receiptStore = yield* RunnerReceiptStore.makeRunnerReceiptStore({
    origin: profile.origin,
    deviceId: profile.deviceId,
    directory: path.join(path.dirname(input.preferencePath), "runner-receipts"),
  })
  const running = yield* Ref.make(new Set<string>())
  yield* report({ _tag: "Registering", registration: checkout.registration })
  while (true) {
    const executorAdmission = yield* admission.awaitAdmission(
      checkout.registration,
      supervisorId,
      report,
      Ref.get(running).pipe(Effect.map((current) => [...current])),
    )
    const assignmentId = String(executorAdmission.assignmentId)
    const started = yield* Ref.modify(running, (current) => {
      if (current.has(assignmentId)) return [false, current] as const
      return [true, new Set(current).add(assignmentId)] as const
    })
    if (!started) {
      yield* Effect.sleep("1 second")
      continue
    }
    const resume =
      executorAdmission._tag === "Resume"
        ? yield* receiptStore.load(assignmentId)
        : Option.none<import("@rika/remote-execution/foreground").ForegroundRunnerSnapshot>()
    if (executorAdmission._tag === "Resume" && Option.isNone(resume)) {
      yield* Ref.update(running, (current) => {
        const next = new Set(current)
        next.delete(assignmentId)
        return next
      })
      yield* report({ _tag: "Waiting", message: "the previous Runner lease has not expired yet" })
      yield* Effect.sleep("1 second")
      continue
    }
    yield* report({ _tag: "Connecting", workspaceIdentity: checkout.registration.workspaceIdentity })
    const ready = yield* Deferred.make<void, ForegroundRunnerError>()
    const socket = yield* Layer.build(foregroundRunnerLayer)
    const runnerOptions =
      executorAdmission._tag === "Resume" ? { resume: Option.getOrThrow(resume) } : { admission: executorAdmission }
    yield* runForegroundRunner({
      ...runnerOptions,
      workspacePath: checkout.workspacePath,
      trustedOrigin: profile.origin,
      ready,
      receiptStore,
      receiptScope: assignmentId,
    }).pipe(
      Effect.provide(socket),
      Effect.mapError((error) => RunnerError.make({ message: error.message })),
      Effect.catch((error) => report({ _tag: "Waiting", message: error.message })),
      Effect.ensuring(
        Ref.update(running, (current) => {
          const next = new Set(current)
          next.delete(assignmentId)
          return next
        }).pipe(
          Effect.andThen(receiptStore.remove(assignmentId).pipe(Effect.ignore)),
          Effect.andThen(report({ _tag: "Stopped" })),
        ),
      ),
      Effect.forkScoped,
    )
    const isConnected = yield* Deferred.await(ready).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (isConnected) {
      if (firstConnection !== undefined) yield* Deferred.succeed(firstConnection, undefined)
      yield* report({ _tag: "Connected", workspaceIdentity: checkout.registration.workspaceIdentity })
    }
  }
})

export const preferencePath = Effect.gen(function* () {
  const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
  return `${home}/.config/rika/runner-admission.json`
})
