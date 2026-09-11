import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { BetterAuthUserId, type HostedOwner } from "@rika/product/hosted-model"
import type { ProductRepositoryService, ThreadAuthorityProjection } from "@rika/product-store/product-repository"
import { Context, Crypto, Effect, Layer } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import {
  makeProductControl,
  type ArchiveThreadInput,
  type ProductActor,
  type ProductControlOptions,
} from "../../src/product/control"

const actor = {
  userId: "archive-user",
  clientId: "archive-client",
  deviceId: "archive-device",
  dpopJkt: "archive-jkt",
} satisfies ProductActor
const owner = {
  _tag: "PersonalOwner",
  userId: BetterAuthUserId.make(actor.userId),
} satisfies HostedOwner
const authority = {
  ownerId: "archive-owner",
  kind: "personal",
  userId: actor.userId,
  organizationId: null,
  membershipId: null,
  createdByUserId: actor.userId,
  executorKind: "runner",
  inheritProjectGrants: false,
  threadRole: null,
  projectRole: null,
} satisfies ThreadAuthorityProjection
const unused = () => Effect.die("Unexpected archive fixture call")
const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({ randomBytes: (size) => new Uint8Array(size), digest: (_algorithm, bytes) => Effect.succeed(bytes) }),
)

const fixture = (
  input: {
    readonly thread?: ThreadAuthorityProjection
    readonly missing?: boolean
    readonly authorize?: HostedClientAuthorityService["authorizeThread"]
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.merge(AuthorizationPolicy.layer, cryptoLayer))
      const archived: Array<Parameters<ProductRepositoryService["archiveThread"]>[0]> = []
      const authorizations: Array<Parameters<HostedClientAuthorityService["authorizeThread"]>[0]> = []
      const product: ProductRepositoryService = {
        stageWorkspaceSeed: unused,
        resolveOwner: unused,
        organizationIds: unused,
        projects: unused,
        projectAccess: unused,
        createProject: unused,
        existingConnection: unused,
        createConnection: unused,
        archiveThread: (request) =>
          Effect.sync(() => {
            archived.push(request)
          }),
        threadAuthority: () => Effect.succeed(input.missing === true ? undefined : (input.thread ?? authority)),
        threadAuthorities: unused,
        personalOwnerId: unused,
        threadMetadataList: unused,
        threadMetadata: unused,
        threadExecutionContext: unused,
        ready: Effect.void,
      }
      const clientAuthority: HostedClientAuthorityService = {
        registerDevice: (request) =>
          Effect.succeed({
            id: request.id,
            userId: request.userId,
            displayName: request.displayName,
            publicKeyFingerprint: request.publicKeyFingerprint,
            createdAt: request.now,
            lastSeenAt: request.now,
            revokedAt: null,
          }),
        authenticateClient: (request) =>
          Effect.succeed({
            id: request.id,
            userId: request.userId,
            deviceId: request.deviceId,
            authenticatedAt: request.now,
            lastSeenAt: request.now,
            expiresAt: request.expiresAt,
            revokedAt: null,
          }),
        grantClientAuthority: () => Effect.void,
        findThread: unused,
        readThread: unused,
        authorizeThread: (request) => {
          authorizations.push(request)
          return input.authorize?.(request) ?? Effect.void
        },
      }
      const options = {
        executorPolicy: { buildId: "archive-build", protocolVersion: 1 },
        product,
        runners: { upsert: unused, setRemoteThreadCreation: unused, claimSupervisorAndPoll: unused },
        clientAuthority,
        authorization: Context.get(services, AuthorizationPolicy),
        crypto: Context.get(services, Crypto.Crypto),
        repositories: { resolve: unused },
      } satisfies ProductControlOptions
      return { control: makeProductControl(options), archived, authorizations }
    }),
  )

it.effect("archives an authorized persisted Thread idempotently without a creation or execution request", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const request = { actor, threadId: "archive-thread" } satisfies ArchiveThreadInput
    expect(yield* test.control.archiveThread(request)).toEqual({ threadId: "archive-thread", archived: true })
    expect(yield* test.control.archiveThread(request)).toEqual({ threadId: "archive-thread", archived: true })
    expect(test.archived).toHaveLength(2)
    expect(
      test.archived.every((value) => value.ownerId === authority.ownerId && value.threadId === request.threadId),
    ).toBe(true)
    expect(test.authorizations).toHaveLength(2)
    expect(test.authorizations[0]).toMatchObject({
      ownerId: authority.ownerId,
      threadId: request.threadId,
      action: "thread:operate",
      actor: { _tag: "PersonalActor", owner, userId: actor.userId, clientId: actor.clientId, deviceId: actor.deviceId },
    })
  }),
)

it.effect("fails closed for malformed, absent, foreign, and unauthorized archive requests", () =>
  Effect.gen(function* () {
    const malformed = yield* fixture()
    expect(yield* Effect.flip(malformed.control.archiveThread({ actor, threadId: " " }))).toMatchObject({
      kind: "invalid",
    })
    expect(malformed.archived).toEqual([])

    const absent = yield* fixture({ missing: true })
    expect(yield* Effect.flip(absent.control.archiveThread({ actor, threadId: "missing" }))).toMatchObject({
      kind: "not-found",
    })
    expect(absent.archived).toEqual([])

    const foreign = yield* fixture({ thread: { ...authority, userId: "foreign-user" } })
    expect(yield* Effect.flip(foreign.control.archiveThread({ actor, threadId: "foreign" }))).toMatchObject({
      kind: "forbidden",
    })
    expect(foreign.archived).toEqual([])

    const denied = yield* fixture({
      authorize: () => Effect.fail(HostedPersistenceError.make({ reason: "invalid-authority", message: "denied" })),
    })
    expect(yield* Effect.flip(denied.control.archiveThread({ actor, threadId: "denied" }))).toMatchObject({
      kind: "forbidden",
    })
    expect(denied.archived).toEqual([])
  }),
)
