import {
  ForegroundLocalExecutorError,
  runForegroundLocalExecutor,
  foregroundLocalExecutorLayer,
} from "@rika/remote-execution/foreground"
import { Config, Console, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { ProjectId } from "@rika/product/hosted-model"
import { inspectLocalCheckout } from "./local-checkout"
import {
  LocalRunnerAdmission,
  LocalRunnerError,
  type LocalRunnerStatus,
  type RemoteThreadCreation,
} from "./local-runner-contract"
import * as Preference from "./local-runner-preference"
import { CredentialStore, HostedError, Http, ProfileStore, type Profile } from "../hosted/hosted-contract"
import { authenticated, selectedProfile } from "../hosted/hosted-account"

const statusLine = (status: LocalRunnerStatus) => {
  if (status._tag === "Registering")
    return `Registering local executor ${status.registration.workspaceIdentity} for device ${status.registration.deviceId}`
  if (status._tag === "Waiting") return `Waiting for local executor: ${status.message}. Placement remains local.`
  if (status._tag === "Connecting") return `Connecting local executor ${status.workspaceIdentity}`
  if (status._tag === "Connected") return `Local executor connected ${status.workspaceIdentity}`
  return "Local executor stopped"
}

const runnerProfile = (
  registration: Parameters<LocalRunnerAdmission["Service"]["awaitAdmission"]>[0],
  profile: Profile,
) => ({
  workspaceIdentity: registration.workspaceIdentity,
  ...(profile.project === undefined ? {} : { projectId: ProjectId.make(profile.project) }),
  repository: registration.repository,
  kernel: registration.kernel,
  capabilities: registration.capabilities,
})

const admissionError = (message: string) => LocalRunnerError.make({ message })
const mapAdmissionError = (error: unknown) =>
  Schema.is(LocalRunnerError)(error)
    ? error
    : admissionError(Schema.is(HostedError)(error) ? error.message : "Hosted local runner admission failed")

export const liveAdmissionLayer = Layer.effect(
  LocalRunnerAdmission,
  Effect.gen(function* () {
    const http = yield* Http
    const credentials = yield* CredentialStore
    const profiles = yield* ProfileStore
    const register = Effect.fn("LocalRunner.register")(function* (
      registration: Parameters<LocalRunnerAdmission["Service"]["awaitAdmission"]>[0],
    ) {
      const profile = yield* selectedProfile()
      if (profile.deviceId !== registration.deviceId)
        return yield* admissionError("The authenticated device does not own this local checkout")
      yield* authenticated(profile, (session) =>
        http.registerLocalRunner(
          profile.origin,
          registration.checkoutFingerprint,
          runnerProfile(registration, profile),
          session,
        ),
      )
      return profile
    })
    return LocalRunnerAdmission.of({
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
          yield* status({ _tag: "Waiting", message: "the hosted Thread has no admitted local work yet" })
          while (true) {
            const result = yield* authenticated(profile, (session) =>
              http.pollLocalRunner(profile.origin, registration.checkoutFingerprint, session),
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

export const prepareLocalCheckout = Effect.fn("LocalRunner.prepareCheckout")(function* (input: {
  readonly workspace: string
  readonly preferencePath: string
  readonly requestedPreference?: RemoteThreadCreation | undefined
}) {
  const profiles = yield* ProfileStore
  const admission = yield* LocalRunnerAdmission
  const profile = yield* profiles.load
  if (Option.isNone(profile)) return yield* LocalRunnerError.make({ message: "Run rika auth login first" })
  const preferences = yield* Preference.make(input.preferencePath)
  const initial = yield* inspectLocalCheckout({
    deviceId: profile.value.deviceId,
    workspace: input.workspace,
    remoteThreadCreation: "denied",
  }).pipe(Effect.mapError(() => LocalRunnerError.make({ message: "Could not inspect the local checkout" })))
  const stored = yield* preferences.get(profile.value.deviceId, initial.registration.checkoutFingerprint)
  const preference = input.requestedPreference ?? stored
  const checkout =
    preference === initial.registration.remoteThreadCreation
      ? initial
      : yield* inspectLocalCheckout({
          deviceId: profile.value.deviceId,
          workspace: input.workspace,
          remoteThreadCreation: preference,
        }).pipe(Effect.mapError(() => LocalRunnerError.make({ message: "Could not inspect the local checkout" })))
  yield* admission.setRemoteThreadCreation(checkout.registration, preference)
  if (input.requestedPreference !== undefined) {
    yield* preferences.set(profile.value.deviceId, checkout.registration.checkoutFingerprint, preference)
  }
  return { profile: profile.value, checkout }
})

export const runLocalRunner = Effect.fn("LocalRunner.run")(function* (input: {
  readonly workspace: string
  readonly preferencePath: string
  readonly requestedPreference?: RemoteThreadCreation | undefined
}) {
  const { profile, checkout } = yield* prepareLocalCheckout(input)
  const admission = yield* LocalRunnerAdmission
  const report = (status: LocalRunnerStatus) => Console.log(statusLine(status))
  yield* report({ _tag: "Registering", registration: checkout.registration })
  while (true) {
    const executorAdmission = yield* admission.awaitAdmission(checkout.registration, report)
    yield* report({ _tag: "Connecting", workspaceIdentity: checkout.registration.workspaceIdentity })
    const ready = yield* Deferred.make<void, ForegroundLocalExecutorError>()
    const socket = yield* Layer.build(foregroundLocalExecutorLayer)
    const executor = yield* runForegroundLocalExecutor({
      admission: executorAdmission,
      workspacePath: checkout.workspacePath,
      trustedOrigin: profile.origin,
      ready,
    }).pipe(
      Effect.provide(socket),
      Effect.mapError((error) => LocalRunnerError.make({ message: error.message })),
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
  return `${home}/.config/rika/local-runner-admission.json`
})
