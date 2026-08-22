import type * as InteractiveFeed from "@rika/product/interactive-feed"
import { Crypto, Effect, Schema } from "effect"
import { OperationUnavailable } from "@rika/product/product-operation"
import { CredentialStore, HostedError, ThreadClient, Http } from "./hosted-contract"
import { authenticated, selectedProfile } from "./hosted-account"
import { makeHostedInteractiveSession } from "./hosted-interactive-session"
import { preferencePath, prepareRunnerCheckout } from "../runner/runner"
import type { InteractiveTuiOptions } from "../interactive/process/interactive-process-loop"
import { interactiveTui } from "../interactive/process/interactive-process-loop"

const operationFailure = (error: unknown) =>
  OperationUnavailable.make({
    operation: "Interactive",
    message: error instanceof Error ? error.message : String(error),
  })

const run = Effect.fn("HostedInteractiveController.run")(function* (
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  yield* authenticated(profile, (session) => http.context(profile.origin, session))
  const prepared = yield* prepareRunnerCheckout({
    workspace: input.workspace ?? process.cwd(),
    preferencePath: yield* preferencePath,
  })
  const threads = yield* ThreadClient
  const crypto = yield* Crypto.Crypto
  const credentials = yield* CredentialStore
  const createThread = (executorKind: "runner" | "orb"): Effect.Effect<string, HostedError> =>
    Effect.gen(function* () {
      const commandId = yield* crypto.randomUUIDv4
      const ticket = yield* authenticated(profile, (session) => http.issueThreadTicket(profile.origin, session))
      return yield* threads.create({
        ticket,
        commandId,
        owner: profile.owner,
        ...(profile.project === undefined ? {} : { project: profile.project }),
        executorKind,
        ...(executorKind === "runner"
          ? {
              runnerTarget: {
                deviceId: prepared.checkout.registration.deviceId,
                checkoutFingerprint: prepared.checkout.registration.checkoutFingerprint,
              },
            }
          : {}),
      })
    }).pipe(
      Effect.provideService(Http, http),
      Effect.provideService(CredentialStore, credentials),
      Effect.mapError((error) =>
        Schema.is(HostedError)(error)
          ? error
          : HostedError.make({ kind: "host", message: "Could not create a hosted Thread identifier" }),
      ),
    )
  const setRemoteThreadCreation = (preference: "allowed" | "denied") =>
    authenticated(profile, (session) =>
      http.setRemoteThreadCreation(
        profile.origin,
        prepared.checkout.registration.checkoutFingerprint,
        preference,
        session,
      ),
    ).pipe(
      Effect.provideService(Http, http),
      Effect.provideService(CredentialStore, credentials),
      Effect.mapError((error) =>
        Schema.is(HostedError)(error)
          ? error
          : HostedError.make({ kind: "host", message: "Could not update Runner admission" }),
      ),
    )
  const threadId = input.threadId ?? (yield* createThread("runner"))
  const hosted = yield* makeHostedInteractiveSession({
    threadId,
    executorKind: "runner",
    createThread: (executorKind) => createThread(executorKind).pipe(Effect.map(String)),
    setRemoteThreadCreation,
  })
  yield* interactiveTui(options)(
    {
      ...input,
      workspace: prepared.checkout.workspacePath,
      threadId,
    },
    hosted.session,
    hosted.connection,
  )
})

export const runHostedInteractive = Effect.fn("HostedInteractiveController.entry")(function* (
  input: InteractiveFeed.InteractiveInput,
  options: InteractiveTuiOptions,
) {
  return yield* run(input, options).pipe(Effect.mapError(operationFailure))
})
