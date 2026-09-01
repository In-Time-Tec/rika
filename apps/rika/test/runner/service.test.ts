import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect"
import { TestClock } from "effect/testing"
import { DeviceId, ExecutorAssignmentId, WorkspaceId } from "@rika/product/hosted-model"
import { CheckoutFingerprint, runnerProtocolVersion } from "@rika/product/runner-registration"
import {
  CredentialStore,
  HostedError,
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
const credential: Credential = {
  refreshToken: Redacted.make("refresh"),
  privateJwk: key,
  accessToken: Redacted.make("access"),
  accessTokenExpiresAt: 2_000_000_000_000,
}
const supervisorId = "10000000-0000-4000-8000-000000000001"
const registration: RunnerRegistration = {
  protocolVersion: runnerProtocolVersion,
  deviceId: DeviceId.make("device-1"),
  checkoutFingerprint: CheckoutFingerprint.make("checkout-1"),
  workspaceIdentity: WorkspaceId.make("workspace-1"),
  repository: {
    identity: "repository-1",
    remoteUrl: "https://example.test/acme/repository.git",
    branch: "main",
  },
  nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.3.14", trustMode: "trusted-local" },
  capabilities: { nativeTools: true, checkpoints: true, pty: true },
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
  listThreads: () => Effect.die("unused"),
  previewThread: () => Effect.die("unused"),
  inspectRecovery: () => Effect.die("unused"),
  resolveRecovery: () => Effect.die("unused"),
  uploadWorkspaceSeed: () => Effect.die("unused"),
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  putProviderCredential: () => Effect.die("unused"),
  listProviderCredentials: () => Effect.die("unused"),
  revokeProviderCredential: () => Effect.die("unused"),
  putOpenAiAccount: () => Effect.die("unused"),
  getOpenAiAccount: () => Effect.die("unused"),
  revokeOpenAiAccount: () => Effect.die("unused"),
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
    const activeAssignments = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
    const statuses = yield* Ref.make<ReadonlyArray<string>>([])
    const http = Http.of({
      ...unusedHttp,
      registerRunner: (_origin, fingerprint, runner) =>
        Ref.update(registrations, (values) => [...values, { fingerprint, runner }]),
      setRemoteThreadCreation: (_origin, _fingerprint, preference) =>
        Ref.update(preferences, (values) => [...values, preference]),
      pollRunner: (_origin, _fingerprint, _supervisorId, active) =>
        Ref.update(activeAssignments, (values) => [...values, active]).pipe(
          Effect.andThen(Ref.getAndUpdate(polls, (value) => value + 1)),
          Effect.map((attempt) =>
            attempt === 0
              ? ({ _tag: "Waiting", reason: "no-work" } as const)
              : ({
                  _tag: "Admitted",
                  assignmentId: ExecutorAssignmentId.make("assignment-1"),
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
      .awaitAdmission(
        registration,
        supervisorId,
        (status) => Ref.update(statuses, (values) => [...values, status._tag]),
        Effect.succeed(["assignment-local"]),
      )
      .pipe(Effect.forkChild)
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toMatchObject({ admissionId: "admission-1", ticket: "ticket-1" })
    yield* admission.setRemoteThreadCreation(registration, "denied")
    expect(yield* Ref.get(preferences)).toEqual(["allowed", "denied"])
    expect(yield* Ref.get(statuses)).toEqual(["Ready", "Waiting"])
    expect(yield* Ref.get(polls)).toBe(2)
    expect(yield* Ref.get(activeAssignments)).toEqual([["assignment-local"], ["assignment-local"]])
    expect(yield* Ref.get(registrations)).toEqual([
      {
        fingerprint: "checkout-1",
        runner: {
          protocolVersion: runnerProtocolVersion,
          workspaceIdentity: "workspace-1",
          projectId: "project-1",
          repository: registration.repository,
          nativeToolRuntime: registration.nativeToolRuntime,
          capabilities: registration.capabilities,
        },
      },
      {
        fingerprint: "checkout-1",
        runner: {
          protocolVersion: runnerProtocolVersion,
          workspaceIdentity: "workspace-1",
          projectId: "project-1",
          repository: registration.repository,
          nativeToolRuntime: registration.nativeToolRuntime,
          capabilities: registration.capabilities,
        },
      },
    ])
  }),
)

it.effect("keeps polling after a transient hosted outage", () =>
  Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const statuses = yield* Ref.make<ReadonlyArray<string>>([])
    const http = Http.of({
      ...unusedHttp,
      registerRunner: () => Effect.void,
      setRemoteThreadCreation: () => Effect.void,
      pollRunner: () =>
        Ref.getAndUpdate(polls, (value) => value + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Effect.fail(HostedError.make({ kind: "network", message: "hosted service restarting" }))
              : Effect.succeed({
                  _tag: "Admitted" as const,
                  assignmentId: ExecutorAssignmentId.make("assignment-after-restart"),
                  admissionId: "admission-after-restart",
                  ticket: "ticket-after-restart",
                  executorUrl: "wss://hosted.example.test/executor",
                  workspaceIdentity: "workspace-1",
                  expiresAt: 2_000_000_000_000,
                }),
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
      .awaitAdmission(
        registration,
        supervisorId,
        (status) =>
          Ref.update(statuses, (values) => [...values, status._tag === "Waiting" ? status.message : status._tag]),
        Effect.succeed([]),
      )
      .pipe(Effect.forkChild)
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toMatchObject({ admissionId: "admission-after-restart" })
    expect(yield* Ref.get(polls)).toBe(2)
    expect(yield* Ref.get(statuses)).toEqual(["Ready", "the service is reconnecting"])
  }),
)

it.effect("keeps the Runner alive when registration overlaps a hosted restart", () =>
  Effect.gen(function* () {
    const registrations = yield* Ref.make(0)
    const statuses = yield* Ref.make<ReadonlyArray<string>>([])
    const http = Http.of({
      ...unusedHttp,
      registerRunner: () =>
        Ref.getAndUpdate(registrations, (value) => value + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Effect.fail(HostedError.make({ kind: "network", message: "hosted service restarting" }))
              : Effect.void,
          ),
        ),
      setRemoteThreadCreation: () => Effect.void,
      pollRunner: () =>
        Effect.succeed({
          _tag: "Admitted" as const,
          assignmentId: ExecutorAssignmentId.make("assignment-after-registration"),
          admissionId: "admission-after-registration",
          ticket: "ticket-after-registration",
          executorUrl: "wss://hosted.example.test/executor",
          workspaceIdentity: "workspace-1",
          expiresAt: 2_000_000_000_000,
        }),
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
      .awaitAdmission(
        registration,
        supervisorId,
        (status) =>
          Ref.update(statuses, (values) => [...values, status._tag === "Waiting" ? status.message : status._tag]),
        Effect.succeed([]),
      )
      .pipe(Effect.forkChild)
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toMatchObject({ admissionId: "admission-after-registration" })
    expect(yield* Ref.get(registrations)).toBe(2)
    expect(yield* Ref.get(statuses)).toEqual(["the service is reconnecting", "Ready"])
  }),
)

it.effect("honors the retry delay when Runner polling is rate limited", () =>
  Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const http = Http.of({
      ...unusedHttp,
      registerRunner: () => Effect.void,
      setRemoteThreadCreation: () => Effect.void,
      pollRunner: () =>
        Ref.getAndUpdate(polls, (value) => value + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Effect.fail(
                  HostedError.make({
                    kind: "rate-limit",
                    message: "Runner admission was rate limited; retry in 3 seconds",
                    status: 429,
                    retryAfterMillis: 3_000,
                  }),
                )
              : Effect.succeed({
                  _tag: "Admitted" as const,
                  assignmentId: ExecutorAssignmentId.make("assignment-after-rate-limit"),
                  admissionId: "admission-after-rate-limit",
                  ticket: "ticket-after-rate-limit",
                  executorUrl: "wss://hosted.example.test/executor",
                  workspaceIdentity: "workspace-1",
                  expiresAt: 2_000_000_000_000,
                }),
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
      .awaitAdmission(registration, supervisorId, () => Effect.void, Effect.succeed([]))
      .pipe(Effect.forkChild)

    yield* TestClock.adjust("2999 millis")
    expect(yield* Ref.get(polls)).toBe(1)
    yield* TestClock.adjust("1 milli")
    expect(yield* Fiber.join(fiber)).toMatchObject({ admissionId: "admission-after-rate-limit" })
    expect(yield* Ref.get(polls)).toBe(2)
  }),
)
