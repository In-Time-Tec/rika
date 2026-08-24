import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  CredentialStore,
  Http,
  ProfileStore,
  type Credential,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../../src/hosted/contract"
import { RunnerAdmission, type RunnerRegistration } from "../../src/runner/contract"
import { liveAdmissionLayer } from "../../src/runner/service"

const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "personal" },
  project: "project-1",
}
const credential: Credential = { refreshToken: Redacted.make("refresh"), privateJwk: key }
const registration: RunnerRegistration = {
  deviceId: "device-1" as never,
  checkoutFingerprint: "checkout-1" as never,
  workspaceIdentity: "workspace-1" as never,
  repository: {
    identity: "repository-1",
    remoteUrl: "https://example.test/acme/repository.git",
    branch: "main",
  },
  kernel: { runtime: "bun", runtimeVersion: "1.3.14", trustMode: "trusted-local" },
  capabilities: { cells: true, checkpoints: true, pty: true },
  remoteThreadCreation: "allowed",
}
const unusedHttp: HttpInterface = {
  register: () => Effect.die("unused"),
  startDeviceAuthorization: () => Effect.die("unused"),
  pollDeviceAuthorization: () => Effect.die("unused"),
  refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
  context: () => Effect.die("unused"),
  invite: () => Effect.die("unused"),
  devices: () => Effect.die("unused"),
  revokeDevice: () => Effect.die("unused"),
  revokeAllDevices: () => Effect.die("unused"),
  issueThreadTicket: () => Effect.die("unused"),
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  putProviderCredential: () => Effect.die("unused"),
  listProviderCredentials: () => Effect.die("unused"),
  revokeProviderCredential: () => Effect.die("unused"),
  createProject: () => Effect.die("unused"),
  putEnvironment: () => Effect.die("unused"),
  revokeEnvironment: () => Effect.die("unused"),
  publishRepository: () => Effect.die("unused"),
}

it.effect("registers the authenticated checkout, waits for admission, and revokes new assignments immediately", () =>
  Effect.gen(function* () {
    const registrations = yield* Ref.make<ReadonlyArray<unknown>>([])
    const preferences = yield* Ref.make<ReadonlyArray<string>>([])
    const polls = yield* Ref.make(0)
    const statuses = yield* Ref.make<ReadonlyArray<string>>([])
    const http = Http.of({
      ...unusedHttp,
      registerRunner: (_origin, fingerprint, runner) =>
        Ref.update(registrations, (values) => [...values, { fingerprint, runner }]),
      setRemoteThreadCreation: (_origin, _fingerprint, preference) =>
        Ref.update(preferences, (values) => [...values, preference]),
      pollRunner: () =>
        Ref.getAndUpdate(polls, (value) => value + 1).pipe(
          Effect.map((attempt) =>
            attempt === 0
              ? ({ _tag: "Waiting" } as const)
              : ({
                  _tag: "Admitted",
                  admissionId: "admission-1",
                  ticket: "ticket-1",
                  executorUrl: "wss://hosted.example.test/executor",
                  workspaceIdentity: "workspace-1",
                  expiresAt: 2_000_000_000_000,
                } as const),
          ),
        ),
    })
    const dependencies = Layer.mergeAll(
      Layer.succeed(Http, http),
      Layer.succeed(
        ProfileStore,
        ProfileStore.of({ load: Effect.succeed(Option.some(profile)), save: () => Effect.void }),
      ),
      Layer.succeed(
        CredentialStore,
        CredentialStore.of({
          load: () => Effect.succeed(Option.some(credential)),
          save: () => Effect.void,
          remove: () => Effect.succeed(true),
          serialized: (effect) => effect,
        }),
      ),
    )
    const context = yield* Layer.build(liveAdmissionLayer.pipe(Layer.provide(dependencies)))
    const admission = Context.get(context, RunnerAdmission)
    const fiber = yield* admission
      .awaitAdmission(registration, (status) => Ref.update(statuses, (values) => [...values, status._tag]))
      .pipe(Effect.forkChild)
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toMatchObject({ admissionId: "admission-1", ticket: "ticket-1" })
    yield* admission.setRemoteThreadCreation(registration, "denied")
    expect(yield* Ref.get(preferences)).toEqual(["allowed", "denied"])
    expect(yield* Ref.get(statuses)).toEqual(["Waiting"])
    expect(yield* Ref.get(polls)).toBe(2)
    expect(yield* Ref.get(registrations)).toEqual([
      {
        fingerprint: "checkout-1",
        runner: {
          workspaceIdentity: "workspace-1",
          projectId: "project-1",
          repository: registration.repository,
          kernel: registration.kernel,
          capabilities: registration.capabilities,
        },
      },
      {
        fingerprint: "checkout-1",
        runner: {
          workspaceIdentity: "workspace-1",
          projectId: "project-1",
          repository: registration.repository,
          kernel: registration.kernel,
          capabilities: registration.capabilities,
        },
      },
    ])
  }),
)
