import {
  ForegroundLocalExecutorError,
  runForegroundLocalExecutor,
  foregroundLocalExecutorLayer,
} from "@rika/remote-execution/foreground"
import { Config, Console, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { inspectLocalCheckout } from "./local-checkout"
import {
  LocalRunnerAdmission,
  LocalRunnerError,
  type LocalRunnerStatus,
  type RemoteThreadCreation,
} from "./local-runner-contract"
import * as Preference from "./local-runner-preference"
import { ProfileStore } from "../hosted/hosted-contract"

const statusLine = (status: LocalRunnerStatus) => {
  if (status._tag === "Registering")
    return `Registering local executor ${status.registration.workspaceIdentity} for device ${status.registration.deviceId}`
  if (status._tag === "Waiting") return `Waiting for local executor: ${status.message}. Placement remains local.`
  if (status._tag === "Connecting") return `Connecting local executor ${status.workspaceIdentity}`
  if (status._tag === "Connected") return `Local executor connected ${status.workspaceIdentity}`
  return "Local executor stopped"
}

export const unavailableAdmissionLayer = Layer.succeed(
  LocalRunnerAdmission,
  LocalRunnerAdmission.of({
    awaitAdmission: (_registration, status) =>
      status({
        _tag: "Waiting",
        message: "the hosted runner-registration protocol is unavailable",
      }).pipe(Effect.andThen(Effect.never)),
    setRemoteThreadCreation: () =>
      Effect.fail(
        LocalRunnerError.make({
          message: "Hosted remote Thread admission cannot be changed until the runner-registration protocol exists",
        }),
      ),
  }),
)

export const runLocalRunner = Effect.fn("LocalRunner.run")(function* (input: {
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
  if (input.requestedPreference !== undefined) {
    yield* admission.setRemoteThreadCreation(checkout.registration, preference)
    yield* preferences.set(profile.value.deviceId, checkout.registration.checkoutFingerprint, preference)
  }
  const report = (status: LocalRunnerStatus) => Console.log(statusLine(status))
  yield* report({ _tag: "Registering", registration: checkout.registration })
  const executorAdmission = yield* admission.awaitAdmission(checkout.registration, report)
  yield* report({ _tag: "Connecting", workspaceIdentity: checkout.registration.workspaceIdentity })
  const ready = yield* Deferred.make<void, ForegroundLocalExecutorError>()
  const socket = yield* Layer.build(foregroundLocalExecutorLayer)
  const executor = yield* runForegroundLocalExecutor({
    admission: executorAdmission,
    workspacePath: checkout.workspacePath,
    trustedOrigin: profile.value.origin,
    ready,
  }).pipe(
    Effect.provide(socket),
    Effect.mapError((error) => LocalRunnerError.make({ message: error.message })),
    Effect.ensuring(report({ _tag: "Stopped" })),
    Effect.forkScoped,
  )
  yield* Deferred.await(ready)
  yield* report({ _tag: "Connected", workspaceIdentity: checkout.registration.workspaceIdentity })
  yield* Fiber.join(executor)
})

export const preferencePath = Effect.gen(function* () {
  const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
  return `${home}/.config/rika/local-runner-admission.json`
})
