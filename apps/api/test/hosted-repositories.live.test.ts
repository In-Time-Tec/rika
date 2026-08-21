import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { installationTestLayer } from "@rika/github-app/installation-service"
import { InstallationToken } from "@rika/github-app/installation-token"
import { identityMigrations, runMigration } from "@rika/identity"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as assignmentLayer } from "@rika/product-store/memory-assignments"
import { Clock, Context, Effect, Layer, Random, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Pool } from "pg"
import { HostedRepositories, layer as repositoryLayer } from "../src/hosted-repositories"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
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

it.effect.skipIf(databaseUrl === undefined)(
  "authorizes one owner installation and resolves an immutable selected checkout",
  () =>
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_repositories_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        yield* Effect.promise(() =>
          pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
          VALUES ('user-1', 'User', 'user@example.test', true, now(), now());
          INSERT INTO "organization" (id, name, slug, created_at)
          VALUES ('organization-1', 'Organization', 'organization', now());
          INSERT INTO rika_hosted_owners (id, kind, organization_id)
          VALUES ('owner-1', 'organization', 'organization-1');
          INSERT INTO rika_hosted_projects (id, owner_id, name, created_by_user_id, created_at, updated_at)
          VALUES ('project-1', 'owner-1', 'Project', 'user-1', now(), now())`),
        )
        let currentAccount = account
        let repositories: ReadonlyArray<typeof repository> = [repository]
        const minted: Array<{
          readonly installationId: number
          readonly repositoryIds: ReadonlyArray<number>
          readonly permissions: Readonly<Record<string, "read" | "write">>
        }> = []
        const revoked: Array<string> = []
        const installationLayer = installationTestLayer({
          verifyInstallation: () => Effect.succeed({ ...installation, account: currentAccount }),
          listRepositories: () => Effect.succeed(repositories),
          reconcileInstallation: () =>
            Effect.succeed({
              installation: { ...installation, account: currentAccount },
              repositories,
              reconciledAtMillis: 1,
            }),
        })
        const tokenLayer = Layer.succeed(
          InstallationToken,
          InstallationToken.of({
            mint: (request) => {
              minted.push(request)
              return Clock.currentTimeMillis.pipe(
                Effect.map((now) => ({
                  token: Redacted.make(`repository-secret-${minted.length}`),
                  expiresAtMillis: now + 30 * 60 * 1_000,
                  installationId: request.installationId,
                  repositoryIds: request.repositoryIds,
                  permissions: request.permissions,
                })),
              )
            },
            revoke: (token) =>
              Effect.sync(() => {
                revoked.push(Redacted.value(token))
              }),
          }),
        )
        const httpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ sha: "a".repeat(40) }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        )
        const dependencies = Layer.mergeAll(
          PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }),
          assignmentLayer,
          installationLayer,
          tokenLayer,
          httpLayer,
        )
        const context = yield* Layer.build(
          repositoryLayer({ baseUrl: "https://github.test" }).pipe(Layer.provide(dependencies)),
        )
        const service = Context.get(context, HostedRepositories)
        const setup = {
          authoritySubject: "owner-1",
          githubIdentity: { userId: 8, login: "maintainer" },
          installation,
        }
        const input = {
          ownerId: "owner-1",
          projectId: "project-1",
          setup,
          repositoryId: repository.id,
          ref: "main",
          gitIdentity: { name: "Organization Committer", email: "committer@example.test" },
        }
        expect(
          (yield* Effect.flip(service.authorize({ ...input, setup: { ...setup, authoritySubject: "owner-2" } })))
            .reason,
        ).toBe("authorization")
        yield* service.authorize(input)
        const checkout = yield* service.resolve({ ownerId: "owner-1", projectId: "project-1" })
        expect(checkout).toEqual({
          ownerId: "owner-1",
          projectId: "project-1",
          repositoryId: "99",
          installationId: "42",
          owner: "octo-org",
          name: "private-repo",
          ref: "main",
          commitSha: "a".repeat(40),
          private: true,
          gitIdentity: { name: "Organization Committer", email: "committer@example.test" },
        })
        expect(minted).toEqual([{ installationId: 42, repositoryIds: [99], permissions: { contents: "read" } }])
        expect(revoked).toEqual(["repository-secret-1"])
        repositories = []
        expect((yield* Effect.flip(service.resolve({ ownerId: "owner-1", projectId: "project-1" }))).reason).toBe(
          "authorization",
        )
        repositories = [repository]
        currentAccount = { ...account, id: 700 }
        expect((yield* Effect.flip(service.resolve({ ownerId: "owner-1", projectId: "project-1" }))).reason).toBe(
          "authorization",
        )
      } finally {
        yield* Effect.promise(() => pool.end())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }).pipe(Effect.scoped),
)
