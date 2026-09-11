import { AuthorizationDenied, type AuthorizationService } from "@rika/product/hosted-authorization"
import { BetterAuthUserId, OrganizationId, type HostedOwner } from "@rika/product/hosted-model"
import { ProductRepositoryError, type OwnerAuthority } from "@rika/product-store/product-repository"
import { RepositoryStoreError } from "@rika/product-store/repositories"
import { StoredArchive, type EncodedArchive } from "@rika/workspace-input/contract"
import { WorkspaceSeedVaultError, type WorkspaceSeedVaultContract } from "@rika/workspace-input/vault"
import { expect, it } from "@effect/vitest"
import { Clock, Crypto, Effect } from "effect"
import { TestClock } from "effect/testing"
import {
  makeWorkspaceSeedService,
  type StageWorkspaceSeedInput,
  type WorkspaceSeedServiceOptions,
} from "../../src/product/workspace-seeds"

const digest = `sha256:${"a".repeat(64)}` as const
const objectDigest = `sha256:${"b".repeat(64)}` as const
const archive: EncodedArchive = { content: "AQ==", contentDigest: digest, sizeBytes: 1 }
const stored = StoredArchive.make({
  objectKey: "workspace-input/v1/workspace-seeds/object/source.archive.aes",
  contentDigest: objectDigest,
  sizeBytes: 64,
  archiveDigest: digest,
  archiveSizeBytes: 1,
  encryption: "aes-256-gcm",
})
const actor = { userId: "user", clientId: "client", deviceId: "device" }
const personalOwner = { _tag: "PersonalOwner", userId: BetterAuthUserId.make("user") } satisfies HostedOwner
const organizationOwner = {
  _tag: "OrganizationOwner",
  organizationId: OrganizationId.make("organization"),
} satisfies HostedOwner
const personalAuthority = { ownerId: "personal-owner", owner: personalOwner, userId: "user" } satisfies OwnerAuthority
const organizationAuthority = {
  ownerId: "organization-owner",
  owner: organizationOwner,
  userId: "user",
  membershipId: "member",
} satisfies OwnerAuthority

interface State {
  readonly resolved: Array<Parameters<WorkspaceSeedServiceOptions["product"]["resolveOwner"]>[0]>
  readonly accesses: Array<Parameters<WorkspaceSeedServiceOptions["product"]["projectAccess"]>[0]>
  readonly bindings: Array<readonly [string, string]>
  readonly authorizations: Array<readonly [string, unknown]>
  readonly stores: Array<readonly [string, EncodedArchive]>
  readonly removals: string[]
  readonly staged: Array<Parameters<WorkspaceSeedServiceOptions["product"]["stageWorkspaceSeed"]>[0]>
}

interface Overrides {
  readonly resolveOwner?: WorkspaceSeedServiceOptions["product"]["resolveOwner"]
  readonly projectAccess?: WorkspaceSeedServiceOptions["product"]["projectAccess"]
  readonly loadBinding?: WorkspaceSeedServiceOptions["repositories"]["loadBinding"]
  readonly authorize?: AuthorizationService["authorize"]
  readonly store?: WorkspaceSeedVaultContract["store"]
  readonly stageWorkspaceSeed?: WorkspaceSeedServiceOptions["product"]["stageWorkspaceSeed"]
}

const fixture = (clock: Clock.Clock, overrides: Overrides = {}) => {
  const state: State = {
    resolved: [],
    accesses: [],
    bindings: [],
    authorizations: [],
    stores: [],
    removals: [],
    staged: [],
  }
  let randomByte = 1
  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
  })
  const product: WorkspaceSeedServiceOptions["product"] = {
    resolveOwner: (input) => {
      state.resolved.push(input)
      return (
        overrides.resolveOwner?.(input) ??
        Effect.succeed(input.selection._tag === "PersonalOwner" ? personalAuthority : organizationAuthority)
      )
    },
    projectAccess: (input) => {
      state.accesses.push(input)
      return overrides.projectAccess?.(input) ?? Effect.succeed({ role: "owner" })
    },
    stageWorkspaceSeed: (input) => {
      state.staged.push(input)
      return overrides.stageWorkspaceSeed?.(input) ?? Effect.void
    },
  }
  const repositories: WorkspaceSeedServiceOptions["repositories"] = {
    loadBinding: (ownerId, projectId) => {
      state.bindings.push([ownerId, projectId])
      return (
        overrides.loadBinding?.(ownerId, projectId) ??
        Effect.succeed({
          ownerId,
          projectId,
          repositoryId: "repository",
          installationId: "installation",
          accountId: "account",
          accountLogin: "organization",
          accountType: "Organization",
          repositoryOwner: "in-time-tec",
          repositoryName: "rika",
          defaultRef: "heads/main",
          private: true,
          gitName: "Rika User",
          gitEmail: "rika@example.test",
        })
      )
    },
  }
  const authorization: AuthorizationService = {
    authorize: (action, subject) => {
      state.authorizations.push([action, subject])
      return overrides.authorize?.(action, subject) ?? Effect.void
    },
  }
  const vault: WorkspaceSeedVaultContract = {
    store: (seedId, value) => {
      state.stores.push([seedId, value])
      return overrides.store?.(seedId, value) ?? Effect.succeed(stored)
    },
    load: () => Effect.die("Unexpected Workspace seed load"),
    remove: (seedId) =>
      Effect.sync(() => {
        state.removals.push(seedId)
      }),
  }
  return {
    state,
    service: makeWorkspaceSeedService({ product, repositories, authorization, vault, crypto, clock }),
  }
}

const stage = (owner: HostedOwner, projectId?: string): StageWorkspaceSeedInput => {
  const input: StageWorkspaceSeedInput = { actor, owner, archive }
  if (projectId !== undefined) Object.assign(input, { projectId })
  return input
}

it.effect("stages personal, organization, and Project inputs only after both authority checks", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000)
    const test = fixture(yield* Clock.Clock)
    const personal = yield* test.service.stage(stage(personalOwner))
    const personalProject = yield* test.service.stage(stage(personalOwner, "personal-project"))
    const organizationProject = yield* test.service.stage(stage(organizationOwner, "organization-project"))

    expect(test.state.staged).toHaveLength(3)
    expect(test.state.resolved).toHaveLength(6)
    expect(test.state.accesses).toHaveLength(4)
    expect(test.state.bindings).toEqual([
      ["personal-owner", "personal-project"],
      ["personal-owner", "personal-project"],
      ["organization-owner", "organization-project"],
      ["organization-owner", "organization-project"],
    ])
    expect(test.state.authorizations).toHaveLength(2)
    expect(test.state.stores.map(([id]) => id)).toEqual([
      personal.workspaceSeedId,
      personalProject.workspaceSeedId,
      organizationProject.workspaceSeedId,
    ])
    expect(test.state.staged[0]).toMatchObject({
      id: personal.workspaceSeedId,
      userId: "user",
      clientId: "client",
      deviceId: "device",
      manifest: { id: personal.workspaceSeedId, sourceRepository: null },
    })
    expect(test.state.staged[1]?.manifest.sourceRepository).toEqual({ owner: "in-time-tec", name: "rika" })
    expect(test.state.staged[2]?.manifest.sourceRepository).toEqual({ owner: "in-time-tec", name: "rika" })
    expect(test.state.staged[0]!.expiresAt.getTime() - test.state.staged[0]!.now.getTime()).toBe(600_000)
    expect(test.state.removals).toEqual([])
  }),
)

it.effect("rejects missing, cross-scope, and read-only Projects before writing an archive", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const missing = fixture(clock, {
      projectAccess: () => Effect.void.pipe(Effect.as<{ readonly role: "owner" } | undefined>(undefined)),
    })
    const readOnly = fixture(clock, { projectAccess: () => Effect.succeed({ role: "viewer" }) })
    const mismatched = fixture(clock, {
      loadBinding: (_ownerId, projectId) =>
        Effect.succeed({
          ownerId: "other-owner",
          projectId,
          repositoryId: "repository",
          installationId: "installation",
          accountId: "account",
          accountLogin: "organization",
          accountType: "Organization",
          repositoryOwner: "in-time-tec",
          repositoryName: "rika",
          defaultRef: "heads/main",
          private: true,
          gitName: "Rika User",
          gitEmail: "rika@example.test",
        }),
    })
    for (const test of [missing, readOnly, mismatched]) {
      const result = yield* Effect.result(test.service.stage(stage(organizationOwner, "project")))
      expect(result._tag).toBe("Failure")
      expect(test.state.stores).toEqual([])
      expect(test.state.staged).toEqual([])
    }
  }),
)

it.effect("removes the encrypted blob when authority is revoked or persistence fails", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    let resolutions = 0
    const revoked = fixture(clock, {
      resolveOwner: () => {
        resolutions += 1
        return resolutions === 1
          ? Effect.succeed(organizationAuthority)
          : Effect.fail(ProductRepositoryError.make({ kind: "forbidden", message: "revoked" }))
      },
    })
    const revokedResult = yield* Effect.result(revoked.service.stage(stage(organizationOwner)))
    expect(revokedResult).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
    expect(revoked.state.removals).toEqual([revoked.state.stores[0]?.[0]])
    expect(revoked.state.staged).toEqual([])

    const secret = "private-persistence-detail"
    const rejected = fixture(clock, {
      stageWorkspaceSeed: () => Effect.fail(ProductRepositoryError.make({ kind: "unavailable", message: secret })),
    })
    const rejectedResult = yield* Effect.result(rejected.service.stage(stage(personalOwner)))
    expect(String(rejectedResult)).not.toContain(secret)
    expect(rejected.state.removals).toEqual([rejected.state.stores[0]?.[0]])
  }),
)

it.effect("surfaces digest and tar validation as redacted invalid input without persistence", () =>
  Effect.gen(function* () {
    const secret = "private-archive-body"
    const test = fixture(yield* Clock.Clock, {
      store: () => Effect.fail(WorkspaceSeedVaultError.make({ kind: "corrupt", message: `invalid tar ${secret}` })),
    })
    const result = yield* Effect.result(test.service.stage(stage(personalOwner)))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "invalid", message: "Workspace archive is invalid" },
    })
    expect(String(result)).not.toContain(secret)
    expect(test.state.staged).toEqual([])
    expect(test.state.removals).toEqual([])
  }),
)

it.effect("redacts repository and authorization failures", () =>
  Effect.gen(function* () {
    const secret = "private-repository-detail"
    const repositoryFailure = fixture(yield* Clock.Clock, {
      loadBinding: () => Effect.fail(RepositoryStoreError.make({ reason: "database", message: secret })),
    })
    const denied = fixture(yield* Clock.Clock, {
      authorize: (_action, subject) =>
        Effect.fail(AuthorizationDenied.make({ action: "project:update", memberId: subject.memberId })),
    })
    for (const test of [repositoryFailure, denied]) {
      const result = yield* Effect.result(test.service.stage(stage(organizationOwner, "project")))
      expect(result._tag).toBe("Failure")
      expect(String(result)).not.toContain(secret)
      expect(test.state.stores).toEqual([])
    }
  }),
)
