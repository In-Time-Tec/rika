import { InstallationError } from "@rika/github-app/installation-service"
import { RepositoryCheckout } from "@rika/product/executor-assignment"
import type { RepositoryBinding } from "@rika/product-store/repositories"
import { Deferred, Effect, Fiber, Inspectable, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import { makeProductRepositories, type ProductRepositoriesOptions } from "../../src/product/repositories"

const account = { id: 7, login: "octo-org", type: "Organization" as const }
const installation = {
  id: 42,
  app_id: 123,
  account,
  repository_selection: "selected" as const,
  permissions: { metadata: "read" as const, contents: "read" as const },
  suspended_at: null,
}
const repository = {
  id: 99,
  name: "private-repo",
  full_name: "octo-org/private-repo",
  private: true,
  archived: false,
  html_url: "https://github.test/octo-org/private-repo",
  owner: account,
}
const binding: RepositoryBinding = {
  projectId: "project-1",
  ownerId: "owner-1",
  repositoryId: "99",
  installationId: "42",
  accountId: "7",
  accountLogin: "octo-org",
  accountType: "Organization",
  repositoryOwner: "octo-org",
  repositoryName: "private-repo",
  defaultRef: "heads/main",
  private: true,
  gitName: "Organization Committer",
  gitEmail: "committer@example.test",
}
const secret = "repository-token-secret"
const commitSha = "a".repeat(40)

interface FixtureState {
  loads: Array<readonly [string, string]>
  reconciliations: number[]
  mints: Array<Parameters<ProductRepositoriesOptions["tokens"]["mint"]>[0]>
  revocations: string[]
  requests: Array<Parameters<Parameters<typeof HttpClient.make>[0]>[0]>
}

interface FixtureOverrides {
  readonly binding?: RepositoryBinding
  readonly reconcile?: ProductRepositoriesOptions["installations"]["reconcileInstallation"]
  readonly execute?: Parameters<typeof HttpClient.make>[0]
  readonly baseUrl?: string
}

const fixture = (overrides: FixtureOverrides = {}) => {
  const state: FixtureState = {
    loads: [],
    reconciliations: [],
    mints: [],
    revocations: [],
    requests: [],
  }
  const options: ProductRepositoriesOptions = {
    store: {
      loadBinding: (ownerId, projectId) =>
        Effect.sync(() => {
          state.loads.push([ownerId, projectId])
          return overrides.binding ?? binding
        }),
    },
    installations: {
      reconcileInstallation: (installationId) =>
        Effect.sync(() => {
          state.reconciliations.push(installationId)
        }).pipe(
          Effect.andThen(
            overrides.reconcile?.(installationId) ??
              Effect.succeed({ installation, repositories: [repository], reconciledAtMillis: 1 }),
          ),
        ),
    },
    tokens: {
      mint: (request) =>
        Effect.sync(() => {
          state.mints.push(request)
          return {
            token: Redacted.make(secret),
            expiresAtMillis: 9_000_000_000_000,
            installationId: request.installationId,
            repositoryIds: request.repositoryIds,
            permissions: request.permissions,
          }
        }),
      revoke: (token) =>
        Effect.sync(() => {
          state.revocations.push(Redacted.value(token))
        }),
    },
    http: HttpClient.make((...args) => {
      const request = args[0]
      return Effect.sync(() => {
        state.requests.push(request)
      }).pipe(
        Effect.andThen(
          overrides.execute?.(...args) ??
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ sha: commitSha }))),
        ),
      )
    }),
  }
  if (overrides.baseUrl !== undefined) Object.assign(options, { baseUrl: overrides.baseUrl })
  else Object.assign(options, { baseUrl: "https://github.test/api/v3" })
  return { state, repositories: makeProductRepositories(options) }
}

const resolve = (test: ReturnType<typeof fixture>) =>
  test.repositories.resolve({ ownerId: "owner-1", projectId: "project-1" })

it.effect("resolves one immutable checkout with the selected repository and stored Git identity", () =>
  Effect.gen(function* () {
    const test = fixture()
    expect(test.state).toEqual({ loads: [], reconciliations: [], mints: [], revocations: [], requests: [] })
    const checkout = yield* resolve(test)
    expect(checkout).toEqual({
      ownerId: "owner-1",
      projectId: "project-1",
      repositoryId: "99",
      installationId: "42",
      owner: "octo-org",
      name: "private-repo",
      ref: "heads/main",
      commitSha,
      private: true,
      gitIdentity: { name: "Organization Committer", email: "committer@example.test" },
    })
    expect(Schema.is(RepositoryCheckout)(checkout)).toBe(true)
    expect(test.state.loads).toEqual([["owner-1", "project-1"]])
    expect(test.state.reconciliations).toEqual([42])
    expect(test.state.mints).toEqual([
      { installationId: 42, repositoryIds: [99], permissions: { contents: "read" }, fresh: true },
    ])
    expect(test.state.requests).toHaveLength(1)
    expect(test.state.requests[0]?.method).toBe("GET")
    expect(test.state.requests[0]?.url).toBe(
      "https://github.test/api/v3/repos/octo-org/private-repo/commits/heads%2Fmain",
    )
    expect(test.state.requests[0]?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${secret}`,
      "x-github-api-version": "2026-03-10",
    })
    expect(test.state.revocations).toEqual([secret])
    expect(Inspectable.toStringUnknown(checkout)).not.toContain(secret)
    expect(Inspectable.toStringUnknown(checkout)).not.toContain("authorization")
  }),
)

it.effect("rejects revoked, moved, unselected, and archived installation inventory before minting", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<ProductRepositoriesOptions["installations"]["reconcileInstallation"]> = [
      () =>
        Effect.fail(
          InstallationError.make({
            reason: "suspended",
            operation: "reconcile installation",
            installationId: 42,
            message: `revoked ${secret}`,
          }),
        ),
      () =>
        Effect.succeed({
          installation,
          repositories: [{ ...repository, owner: { ...account, login: "moved-org" } }],
          reconciledAtMillis: 1,
        }),
      () => Effect.succeed({ installation, repositories: [], reconciledAtMillis: 1 }),
      () => Effect.succeed({ installation, repositories: [{ ...repository, archived: true }], reconciledAtMillis: 1 }),
      () =>
        Effect.succeed({
          installation: { ...installation, account: { ...account, id: 8 } },
          repositories: [repository],
          reconciledAtMillis: 1,
        }),
    ]
    for (const reconcile of cases) {
      const test = fixture({ reconcile })
      const result = yield* Effect.result(resolve(test))
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
      expect(Inspectable.toStringUnknown(result)).not.toContain(secret)
      expect(test.state.mints).toEqual([])
      expect(test.state.requests).toEqual([])
      expect(test.state.revocations).toEqual([])
    }

    const wrongOwner = fixture({ binding: { ...binding, ownerId: "owner-2" } })
    expect((yield* Effect.result(resolve(wrongOwner)))._tag).toBe("Failure")
    expect(wrongOwner.state.reconciliations).toEqual([])
    expect(wrongOwner.state.mints).toEqual([])

    const invalidIdentity = fixture({ binding: { ...binding, gitEmail: "invalid" } })
    expect((yield* Effect.result(resolve(invalidIdentity)))._tag).toBe("Failure")
    expect(invalidIdentity.state.reconciliations).toEqual([])
    expect(invalidIdentity.state.mints).toEqual([])
  }),
)

it.effect("releases the scoped token after HTTP, body, and schema failures without leaking request diagnostics", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<Parameters<typeof HttpClient.make>[0]> = [
      () => Effect.die(new Error(`raw request failed with Bearer ${secret}`)),
      (request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }))),
      (request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ sha: commitSha }), {
              headers: { "content-length": String(1_048_577) },
            }),
          ),
        ),
      (request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new Uint8Array(1_048_577)))),
      (request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ sha: "not-a-commit" }))),
    ]
    for (const execute of cases) {
      const test = fixture({ execute })
      const result = yield* Effect.result(resolve(test))
      expect(result._tag).toBe("Failure")
      expect(Inspectable.toStringUnknown(result)).not.toContain(secret)
      expect(Inspectable.toStringUnknown(result)).not.toContain("Bearer")
      expect(test.state.mints).toHaveLength(1)
      expect(test.state.revocations).toEqual([secret])
    }
  }),
)

it.effect("releases the scoped token when checkout resolution is interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const test = fixture({
      execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    })
    const pending = yield* resolve(test).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    expect(test.state.mints).toHaveLength(1)
    expect(test.state.revocations).toEqual([secret])
  }),
)

it.effect("fails before repository access when the configured GitHub base URL is not verified", () =>
  Effect.gen(function* () {
    for (const baseUrl of ["http://github.test", "https://token@github.test", "https://github.test?token=secret"]) {
      const test = fixture({ baseUrl })
      const result = yield* Effect.result(resolve(test))
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "invalid" } })
      expect(test.state.loads).toEqual([])
      expect(test.state.reconciliations).toEqual([])
      expect(test.state.mints).toEqual([])
      expect(test.state.requests).toEqual([])
    }
  }),
)
