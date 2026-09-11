/* oxlint-disable max-lines -- product control validation and persistence routing stay mirrored in one focused suite. */
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import {
  BetterAuthUserId,
  DeviceId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
  type HostedOwner,
  type JsonObject,
} from "@rika/product/hosted-model"
import {
  CheckoutFingerprint,
  runnerProtocolVersion,
  type RunnerProfile,
  type RunnerTarget,
} from "@rika/product/runner-registration"
import {
  ProductRepositoryError,
  type CreateConnectionResult,
  type OwnerAuthority,
  type ProductRepositoryService,
} from "@rika/product-store/product-repository"
import { RunnerRegistrationsError, type RunnerRegistrationsService } from "@rika/product-store/runner-registrations"
import { Context, Crypto, Effect, Layer } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import {
  makeProductControl,
  type CreateThreadInput,
  type ProductActor,
  type ProductControlOptions,
} from "../../src/product/control"
import "./archive.harness"
type ProductOverrides = Partial<
  Pick<
    ProductRepositoryService,
    "resolveOwner" | "organizationIds" | "projectAccess" | "existingConnection" | "createConnection"
  >
>
type ClientOverrides = Partial<
  Pick<HostedClientAuthorityService, "authorizeThread" | "registerDevice" | "authenticateClient">
>
type RunnerOverrides = Partial<
  Pick<RunnerRegistrationsService, "upsert" | "setRemoteThreadCreation" | "claimSupervisorAndPoll">
>

interface Calls {
  readonly resolvedOwners: Array<Parameters<ProductRepositoryService["resolveOwner"]>[0]>
  readonly projectAccesses: Array<Parameters<ProductRepositoryService["projectAccess"]>[0]>
  readonly createdConnections: Array<Parameters<ProductRepositoryService["createConnection"]>[0]>
  readonly repositoryResolutions: Array<Parameters<ProductControlOptions["repositories"]["resolve"]>[0]>
  readonly archiveAuthorizations: Array<Parameters<HostedClientAuthorityService["authorizeThread"]>[0]>
}

interface FixtureOptions {
  readonly product?: ProductOverrides
  readonly clientAuthority?: ClientOverrides
  readonly runners?: RunnerOverrides
  readonly configuredOrb?: boolean
}

const actor = {
  userId: "user",
  clientId: "client",
  deviceId: "requesting-device",
  dpopJkt: "dpop-jkt",
} satisfies ProductActor

const personalOwner = {
  _tag: "PersonalOwner",
  userId: BetterAuthUserId.make(actor.userId),
} satisfies HostedOwner

const organizationOwner = {
  _tag: "OrganizationOwner",
  organizationId: OrganizationId.make("organization"),
} satisfies HostedOwner

const personalAuthority = {
  ownerId: "personal-owner",
  owner: personalOwner,
  userId: actor.userId,
} satisfies OwnerAuthority

const organizationAuthority = {
  ownerId: "organization-owner",
  owner: organizationOwner,
  userId: actor.userId,
  membershipId: "member",
} satisfies OwnerAuthority

const runnerTarget = {
  deviceId: DeviceId.make("runner-device"),
  checkoutFingerprint: CheckoutFingerprint.make("checkout"),
} satisfies RunnerTarget

const runnerProfile = {
  protocolVersion: runnerProtocolVersion,
  workspaceIdentity: WorkspaceId.make("workspace"),
  projectId: ProjectId.make("project"),
  repository: { identity: "owner/repository", remoteUrl: "https://example.test/owner/repository.git" },
  nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.4.0", trustMode: "trusted-local" },
  capabilities: { nativeTools: true, checkpoints: true, pty: true },
} satisfies RunnerProfile

const checkout: JsonObject = { repository: "owner/repository" }
const configuredOrb = { templateBuildId: "template-build", providerScope: "provider-scope" } satisfies NonNullable<
  ProductControlOptions["orb"]
>

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
  }),
)

const unused = () => Effect.die("unused product-control test seam")
const none = <A>(): Effect.Effect<A | undefined, never> => Effect.as(Effect.void, undefined)
const ownerFor = (selection: HostedOwner): OwnerAuthority =>
  selection._tag === "PersonalOwner" ? personalAuthority : organizationAuthority
const calls = (): Calls => ({
  resolvedOwners: [],
  projectAccesses: [],
  createdConnections: [],
  repositoryResolutions: [],
  archiveAuthorizations: [],
})

const makeProduct = (recorded: Calls, overrides: ProductOverrides = {}): ProductRepositoryService => ({
  stageWorkspaceSeed: unused,
  resolveOwner: (input) =>
    Effect.sync(() => {
      recorded.resolvedOwners.push(input)
      return ownerFor(input.selection)
    }),
  organizationIds: () => Effect.succeed([]),
  projects: () => Effect.succeed([]),
  projectAccess: (input) =>
    Effect.sync(() => {
      recorded.projectAccesses.push(input)
      return { role: "owner" }
    }),
  createProject: unused,
  existingConnection: () => none<never>(),
  createConnection: (input) =>
    Effect.sync(() => {
      recorded.createdConnections.push(input)
      return { _tag: "Created", threadId: input.threadId } satisfies CreateConnectionResult
    }),
  archiveThread: unused,
  threadAuthority: unused,
  threadAuthorities: unused,
  personalOwnerId: unused,
  threadMetadataList: unused,
  threadMetadata: unused,
  threadExecutionContext: unused,
  ready: Effect.void,
  ...overrides,
})

const makeClientAuthority = (recorded: Calls, overrides: ClientOverrides = {}): HostedClientAuthorityService => ({
  registerDevice: (input) =>
    Effect.sync(() => ({
      id: input.id,
      userId: input.userId,
      displayName: input.displayName,
      publicKeyFingerprint: input.publicKeyFingerprint,
      createdAt: input.now,
      lastSeenAt: input.now,
      revokedAt: null,
    })),
  authenticateClient: (input) =>
    Effect.sync(() => ({
      id: input.id,
      userId: input.userId,
      deviceId: input.deviceId,
      authenticatedAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    })),
  grantClientAuthority: () => Effect.void,
  findThread: unused,
  readThread: unused,
  authorizeThread: (input) =>
    Effect.sync(() => {
      recorded.archiveAuthorizations.push(input)
    }),
  ...overrides,
})

const makeRunners = (overrides: RunnerOverrides = {}): RunnerRegistrationsService => ({
  upsert: () => Effect.succeed("stored"),
  setRemoteThreadCreation: () => Effect.succeed(true),
  claimSupervisorAndPoll: unused,
  ...overrides,
})

const makeFixture = (options: FixtureOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.merge(AuthorizationPolicy.layer, cryptoLayer))
      const crypto = Context.get(services, Crypto.Crypto)
      const authorization = Context.get(services, AuthorizationPolicy)
      const recorded = calls()
      const controlOptions = {
        executorPolicy: { buildId: "test-build", protocolVersion: 1 },
        product: makeProduct(recorded, options.product),
        runners: makeRunners(options.runners),
        clientAuthority: makeClientAuthority(recorded, options.clientAuthority),
        authorization,
        crypto,
        repositories: {
          resolve: (input) =>
            Effect.sync(() => {
              recorded.repositoryResolutions.push(input)
              return checkout
            }),
        },
      } satisfies Omit<ProductControlOptions, "orb">
      return {
        calls: recorded,
        control:
          options.configuredOrb === false
            ? makeProductControl(controlOptions)
            : makeProductControl({ ...controlOptions, orb: configuredOrb }),
      }
    }),
  )

const runnerThread = (threadId: string): CreateThreadInput => ({
  actor,
  owner: personalOwner,
  threadId,
  target: "runner",
  runnerTarget,
})

const projectRunnerThread = (threadId: string, owner: HostedOwner, projectId: string): CreateThreadInput => ({
  actor,
  owner,
  threadId,
  target: "runner",
  runnerTarget,
  projectId,
})

const orbThread = (threadId: string): CreateThreadInput => ({
  actor,
  owner: personalOwner,
  threadId,
  target: "orb",
})

const seededOrbThread = (
  threadId: string,
  projectId: string,
  workspaceSeedId: string,
  archiveThreadId: string,
): CreateThreadInput => ({
  actor,
  owner: personalOwner,
  threadId,
  target: "orb",
  projectId,
  workspaceSeedId,
  archiveThreadId,
})

it.effect("selects personal and organization Projects through their authorized owners", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()

    expect(
      yield* fixture.control.createThread(projectRunnerThread("personal-thread", personalOwner, "personal-project")),
    ).toEqual({
      threadId: "personal-thread",
    })
    expect(
      yield* fixture.control.createThread(
        projectRunnerThread("organization-thread", organizationOwner, "organization-project"),
      ),
    ).toEqual({ threadId: "organization-thread" })
    expect(fixture.calls.projectAccesses).toEqual([
      { authority: personalAuthority, projectId: "personal-project" },
      { authority: organizationAuthority, projectId: "organization-project" },
    ])
    expect(fixture.calls.resolvedOwners.map((input) => input.selection)).toEqual([personalOwner, organizationOwner])
  }),
)

it.effect("rejects unavailable and insufficiently authorized organization Projects", () =>
  Effect.gen(function* () {
    const denied = yield* makeFixture({ product: { projectAccess: () => Effect.succeed({ role: "viewer" }) } })
    expect(
      yield* Effect.flip(denied.control.createThread(projectRunnerThread("denied", organizationOwner, "project"))),
    ).toMatchObject({
      kind: "forbidden",
      message: "Product operation is not authorized",
    })
    expect(denied.calls.createdConnections).toEqual([])

    const missing = yield* makeFixture({ product: { projectAccess: () => none<never>() } })
    expect(
      yield* Effect.flip(missing.control.createThread(projectRunnerThread("missing", organizationOwner, "project"))),
    ).toMatchObject({
      kind: "not-found",
      message: "Project is unavailable",
    })
    expect(missing.calls.createdConnections).toEqual([])
  }),
)

it.effect("requires an explicit compatible Runner placement", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const invalid: ReadonlyArray<CreateThreadInput> = [
      { actor, owner: personalOwner, threadId: "runner-without-target", target: "runner" },
      { actor, owner: personalOwner, threadId: "orb-with-runner", target: "orb", runnerTarget },
      {
        actor,
        owner: personalOwner,
        threadId: "runner-with-seed",
        target: "runner",
        runnerTarget,
        workspaceSeedId: "seed",
      },
    ]
    for (const input of invalid)
      expect(yield* Effect.flip(fixture.control.createThread(input))).toMatchObject({
        kind: "invalid",
        message: "Thread creation placement is invalid",
      })
    expect(fixture.calls.resolvedOwners).toEqual([])
  }),
)

it.effect("retries an existing Thread without another create and rejects an incompatible identity", () =>
  Effect.gen(function* () {
    const existing = yield* makeFixture({
      product: { existingConnection: (input) => Effect.succeed({ _tag: "Existing", threadId: input.threadId }) },
    })
    const retry = { ...runnerThread("retry"), archiveThreadId: "archive" } satisfies CreateThreadInput
    expect(yield* existing.control.createThread(retry)).toEqual({ threadId: "retry" })
    expect(existing.calls.createdConnections).toEqual([])
    expect(existing.calls.archiveAuthorizations).toEqual([])

    const incompatible = yield* makeFixture({
      product: { existingConnection: () => Effect.succeed({ _tag: "Incompatible" }) },
    })
    expect(yield* Effect.flip(incompatible.control.createThread(runnerThread("incompatible")))).toMatchObject({
      kind: "conflict",
      message: "Thread identity has different creation input",
    })
    expect(incompatible.calls.createdConnections).toEqual([])
  }),
)

it.effect("maps Runner admission rejections to safe product errors", () =>
  Effect.gen(function* () {
    const outcomes = [
      { result: { _tag: "RunnerMissing" }, kind: "not-found", message: "Runner is unavailable" },
      {
        result: { _tag: "RunnerAuthorityMismatch" },
        kind: "forbidden",
        message: "Product operation is not authorized",
      },
      { result: { _tag: "RunnerRemoteDenied" }, kind: "forbidden", message: "Product operation is not authorized" },
    ] satisfies ReadonlyArray<{
      readonly result: Extract<
        CreateConnectionResult,
        { readonly _tag: "RunnerMissing" | "RunnerAuthorityMismatch" | "RunnerRemoteDenied" }
      >
      readonly kind: "not-found" | "forbidden"
      readonly message: string
    }>
    for (const outcome of outcomes) {
      let createCalls = 0
      const fixture = yield* makeFixture({
        product: {
          createConnection: () =>
            Effect.sync(() => {
              createCalls += 1
              return outcome.result
            }),
        },
      })
      expect(yield* Effect.flip(fixture.control.createThread(runnerThread(outcome.result._tag)))).toMatchObject({
        kind: outcome.kind,
        message: outcome.message,
      })
      expect(createCalls).toBe(1)
    }
  }),
)

it.effect("forbids Runner identity replacement and reports a missing remote preference", () =>
  Effect.gen(function* () {
    const mismatch = yield* makeFixture({ runners: { upsert: () => Effect.succeed("user-mismatch") } })
    expect(
      yield* Effect.flip(
        mismatch.control.registerRunner({ actor, checkoutFingerprint: "checkout", profile: runnerProfile }),
      ),
    ).toMatchObject({ kind: "forbidden", message: "Product operation is not authorized" })

    const missing = yield* makeFixture({ runners: { setRemoteThreadCreation: () => Effect.succeed(false) } })
    expect(
      yield* Effect.flip(
        missing.control.setRemoteThreadCreation({ actor, checkoutFingerprint: "checkout", allowed: true }),
      ),
    ).toMatchObject({ kind: "not-found", message: "Runner is unavailable" })
  }),
)

it.effect("claims the Runner supervisor lease and polls assignments without re-activating the client", () =>
  Effect.gen(function* () {
    const polls: Array<Parameters<RunnerRegistrationsService["claimSupervisorAndPoll"]>[0]> = []
    const assignment = {
      assignmentId: "assignment",
      threadId: "thread",
      workspaceId: "workspace",
      resume: true,
      leaseExpiresAt: 1_757_376_000_000,
    }
    const fixture = yield* makeFixture({
      runners: {
        claimSupervisorAndPoll: (input) =>
          Effect.sync(() => {
            polls.push(input)
            return { claimed: true as const, assignment }
          }),
      },
      // Polling runs on the already authenticated device; re-registering it every cycle would rewrite client rows.
      clientAuthority: { registerDevice: unused, authenticateClient: unused },
    })
    expect(
      yield* fixture.control.pollRunnerAssignment({
        actor,
        checkoutFingerprint: "checkout",
        supervisorId: "supervisor",
        activeAssignmentIds: ["assignment-a"],
      }),
    ).toEqual({ claimed: true, assignment })
    expect(polls).toEqual([
      {
        deviceId: actor.deviceId,
        userId: actor.userId,
        checkoutFingerprint: "checkout",
        supervisorId: "supervisor",
        activeAssignmentIds: ["assignment-a"],
      },
    ])

    const contended = yield* makeFixture({
      runners: { claimSupervisorAndPoll: () => Effect.succeed({ claimed: false }) },
    })
    expect(
      yield* contended.control.pollRunnerAssignment({
        actor,
        checkoutFingerprint: "checkout",
        supervisorId: "supervisor",
        activeAssignmentIds: [],
      }),
    ).toEqual({ claimed: false })
  }),
)

it.effect("rejects malformed Runner poll input before consulting the registration store", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      runners: { claimSupervisorAndPoll: unused },
      clientAuthority: { registerDevice: unused, authenticateClient: unused },
    })
    const poll = (input: {
      readonly checkoutFingerprint: string
      readonly supervisorId: string
      readonly activeAssignmentIds: ReadonlyArray<string>
    }) => fixture.control.pollRunnerAssignment({ actor, ...input })
    for (const input of [
      { checkoutFingerprint: "checkout", supervisorId: "", activeAssignmentIds: [] },
      { checkoutFingerprint: "checkout", supervisorId: " ".repeat(4), activeAssignmentIds: [] },
      { checkoutFingerprint: "checkout", supervisorId: "s".repeat(257), activeAssignmentIds: [] },
      { checkoutFingerprint: "checkout", supervisorId: "supervisor", activeAssignmentIds: [""] },
      { checkoutFingerprint: "checkout", supervisorId: "supervisor", activeAssignmentIds: ["a".repeat(513)] },
      {
        checkoutFingerprint: "checkout",
        supervisorId: "supervisor",
        activeAssignmentIds: Array.from({ length: 65 }, (_, index) => `id-${index}`),
      },
      { checkoutFingerprint: "bad fingerprint", supervisorId: "supervisor", activeAssignmentIds: [] },
    ])
      expect(yield* Effect.flip(poll(input))).toMatchObject({
        kind: "invalid",
        message: "Runner poll input is invalid",
      })
  }),
)

it.effect("maps Runner poll store failures to unavailable", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({
      runners: {
        claimSupervisorAndPoll: () =>
          RunnerRegistrationsError.make({ message: "runner store password: should-not-escape" }),
      },
      clientAuthority: { registerDevice: unused, authenticateClient: unused },
    })
    const error = yield* Effect.flip(
      fixture.control.pollRunnerAssignment({
        actor,
        checkoutFingerprint: "checkout",
        supervisorId: "supervisor",
        activeAssignmentIds: [],
      }),
    )
    expect(error).toMatchObject({ kind: "unavailable", message: "Product service is unavailable" })
    expect(error.message).not.toContain("password")
  }),
)

it.effect("persists placement, requester binding, and Orb-only project checkout inputs", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    expect(yield* fixture.control.createThread(projectRunnerThread("runner-thread", personalOwner, "project"))).toEqual(
      {
        threadId: "runner-thread",
      },
    )
    expect(yield* fixture.control.createThread(seededOrbThread("orb-thread", "project", "seed", "archive"))).toEqual({
      threadId: "orb-thread",
    })

    const [runnerConnection, orbConnection] = fixture.calls.createdConnections
    expect(runnerConnection).toMatchObject({
      threadId: "runner-thread",
      executorKind: "runner",
      requestingDeviceId: actor.deviceId,
      requestingClientId: actor.clientId,
      placement: { _tag: "RunnerPlacement", ...runnerTarget, requestingDeviceId: actor.deviceId },
      checkout: null,
    })
    expect(orbConnection).toMatchObject({
      threadId: "orb-thread",
      executorKind: "orb",
      workspaceSeedId: "seed",
      archiveThreadId: "archive",
      requestingDeviceId: actor.deviceId,
      requestingClientId: actor.clientId,
      placement: { _tag: "OrbPlacement", ...configuredOrb },
      checkout,
    })
    expect(fixture.calls.repositoryResolutions).toEqual([{ ownerId: personalAuthority.ownerId, projectId: "project" }])
    expect(fixture.calls.archiveAuthorizations).toMatchObject([
      {
        ownerId: personalAuthority.ownerId,
        threadId: "archive",
        action: "thread:operate",
        actor: {
          _tag: "PersonalActor",
          owner: personalOwner,
          userId: actor.userId,
          clientId: actor.clientId,
          deviceId: actor.deviceId,
        },
      },
    ])
  }),
)

it.effect("fails closed without Orb configuration and hides persistence failure details", () =>
  Effect.gen(function* () {
    const unavailableOrb = yield* makeFixture({ configuredOrb: false })
    expect(yield* Effect.flip(unavailableOrb.control.createThread(orbThread("unconfigured-orb")))).toMatchObject({
      kind: "unavailable",
      message: "Orb execution is not configured",
    })
    expect(unavailableOrb.calls.createdConnections).toEqual([])

    const deniedArchive = yield* makeFixture({
      clientAuthority: {
        authorizeThread: () =>
          Effect.fail(HostedPersistenceError.make({ reason: "invalid-authority", message: "denied" })),
      },
    })
    expect(
      yield* Effect.flip(
        deniedArchive.control.createThread(seededOrbThread("denied-archive", "project", "seed", "archive")),
      ),
    ).toMatchObject({ kind: "forbidden", message: "Product operation is not authorized" })
    expect(deniedArchive.calls.createdConnections).toEqual([])
    expect(deniedArchive.calls.repositoryResolutions).toEqual([])

    const productFailure = yield* makeFixture({
      product: {
        createConnection: () =>
          Effect.fail(
            ProductRepositoryError.make({ kind: "conflict", message: "database password: should-not-escape" }),
          ),
      },
    })
    const productError = yield* Effect.flip(productFailure.control.createThread(runnerThread("database-failure")))
    expect(productError).toMatchObject({ kind: "conflict", message: "Product metadata operation was rejected" })
    expect(productError.message).not.toContain("password")
  }),
)
