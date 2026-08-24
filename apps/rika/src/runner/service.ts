import { ForegroundRunnerError, runForegroundRunner, foregroundRunnerLayer } from "@rika/remote-execution/foreground"
import { Config, Console, Context, Deferred, Effect, Fiber, Function, Layer, Option, Schema } from "effect"
import type { Success } from "effect/Effect"
import { ProjectId } from "@rika/product/hosted-model"
import { inspectRunnerCheckout } from "./checkout"
import { RunnerAdmission, RunnerError, type RunnerStatus, type RemoteThreadCreation } from "./contract"
import * as Preference from "./preference"
import { CredentialStore, HostedError, Http, ProfileStore, type Profile } from "../hosted/contract"
import { authenticated, selectedProfile } from "../hosted/account"

const statusLine = (status: RunnerStatus) => {
  if (status._tag === "Registering")
    return `Registering Runner ${status.registration.workspaceIdentity} for device ${status.registration.deviceId}`
  if (status._tag === "Waiting") return `Waiting for Runner: ${status.message}.`
  if (status._tag === "Connecting") return `Connecting Runner ${status.workspaceIdentity}`
  if (status._tag === "Connected") return `Runner connected ${status.workspaceIdentity}`
  return "Runner stopped"
}

const runnerProfile = (
  registration: Parameters<RunnerAdmission["Service"]["awaitAdmission"]>[0],
  profile: Profile,
) => ({
  workspaceIdentity: registration.workspaceIdentity,
  ...(profile.project === undefined ? {} : { projectId: ProjectId.make(profile.project) }),
  repository: registration.repository,
  kernel: registration.kernel,
  capabilities: registration.capabilities,
})

const admissionError = (message: string) => RunnerError.make({ message })
const mapAdmissionError = (error: unknown) =>
  Schema.is(RunnerError)(error)
    ? error
    : admissionError(Schema.is(HostedError)(error) ? error.message : "Hosted Runner admission failed")

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
      awaitAdmission: (registration, status) =>
        Effect.gen(function* () {
          const profile = yield* register(registration)
          yield* authenticated(profile, (session) =>
            http.setRemoteThreadCreation(
              profile.origin,
              registration.checkoutFingerprint,
              registration.remoteThreadCreation,
              session,
            ),
          )
          yield* status({ _tag: "Waiting", message: "the hosted Thread has no admitted Runner work yet" })
          while (true) {
            const result = yield* authenticated(profile, (session) =>
              http.pollRunner(profile.origin, registration.checkoutFingerprint, session),
            )
            if (result._tag === "Admitted") return result
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
  (input: Parameters<typeof prepareRunnerCheckoutOnce>[0]): <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => ReturnType<typeof withPreparedRunnerCheckoutImpl<A, E, R>>
} = Function.dual(2, withPreparedRunnerCheckoutImpl)

export const runRunner = Effect.fn("Runner.run")(function* (input: {
  readonly workspace: string
  readonly preferencePath: string
  readonly requestedPreference?: RemoteThreadCreation | undefined
}, prepared?: PreparedRunnerCheckout) {
  const { profile, checkout } = prepared ?? (yield* prepareRunnerCheckout(input))
  const admission = yield* RunnerAdmission
  const report = (status: RunnerStatus) => Console.log(statusLine(status))
  yield* report({ _tag: "Registering", registration: checkout.registration })
  while (true) {
    const executorAdmission = yield* admission.awaitAdmission(checkout.registration, report)
    yield* report({ _tag: "Connecting", workspaceIdentity: checkout.registration.workspaceIdentity })
    const ready = yield* Deferred.make<void, ForegroundRunnerError>()
    const socket = yield* Layer.build(foregroundRunnerLayer)
    const executor = yield* runForegroundRunner({
      admission: executorAdmission,
      workspacePath: checkout.workspacePath,
      trustedOrigin: profile.origin,
      ready,
    }).pipe(
      Effect.provide(socket),
      Effect.mapError((error) => RunnerError.make({ message: error.message })),
      Effect.ensuring(report({ _tag: "Stopped" })),
      Effect.forkScoped,
    )
    yield* Deferred.await(ready)
    yield* report({ _tag: "Connected", workspaceIdentity: checkout.registration.workspaceIdentity })
    yield* Fiber.join(executor).pipe(Effect.catch((error) => report({ _tag: "Waiting", message: error.message })))
  }
})

export const preferencePath = Effect.gen(function* () {
  const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
  return `${home}/.config/rika/runner-admission.json`
})
