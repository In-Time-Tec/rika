import * as PgClient from "@effect/sql-pg/PgClient"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { installationTestLayer } from "@rika/github-app/installation-service"
import { InstallationToken } from "@rika/github-app/installation-token"
import { identityMigrations, runMigration } from "@rika/identity"
import { BetterAuthUserId, ClientId, DeviceId } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as assignmentLayer } from "@rika/product-store/memory-assignments"
import { FileSystem, Config, Clock, Context, Effect, Layer, Random, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Pool } from "pg"
import { live as livePlatform } from "./live-platform"
import { HostedRepositories, layer as repositoryLayer } from "../src/hosted-repositories"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
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

it.effect.skipIf(databaseUrl === "")(
  "authorizes one owner installation and resolves an immutable selected checkout",
  () =>
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_repositories_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFileString(migration.url.pathname),
          )
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        yield* Effect.tryPromise(() =>
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
            Effect.sync(() => {
              const path = new URL(request.url).pathname
              const response = path.includes("/branches/rika%2Fthread-personal")
                ? new Response(undefined, { status: 404 })
                : Response.json(
                    path.endsWith("/branches/main")
                      ? { name: "main", protected: true, commit: { sha: "b".repeat(40) } }
                      : { sha: "a".repeat(40) },
                  )
              return HttpClientResponse.fromWeb(request, response)
            }),
          ),
        )
        const dependencies = Layer.mergeAll(
          BunCrypto.layer,
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
        expect(minted).toEqual([
          { installationId: 42, repositoryIds: [99], permissions: { contents: "read" }, fresh: false },
        ])
        expect(revoked).toEqual(["repository-secret-1"])
        yield* Effect.tryPromise(() =>
          pool.query(`INSERT INTO rika_hosted_owners (id, kind, user_id)
            VALUES ('owner-personal', 'personal', 'user-1');
          INSERT INTO rika_hosted_projects (id, owner_id, name, created_by_user_id, created_at, updated_at)
            VALUES ('project-personal', 'owner-personal', 'Personal Project', 'user-1', now(), now());
          INSERT INTO rika_hosted_devices
            (id, user_id, display_name, public_key_fingerprint, created_at, last_seen_at)
            VALUES ('device-personal', 'user-1', 'Personal Device', 'fingerprint-personal', now(), now());
          INSERT INTO rika_hosted_clients
            (id, user_id, device_id, authenticated_at, last_seen_at, expires_at)
            VALUES ('client-personal', 'user-1', 'device-personal', now(), now(), now() + interval '5 minutes')`),
        )
        yield* service.authorize({
          ...input,
          ownerId: "owner-personal",
          projectId: "project-personal",
          setup: { ...setup, authoritySubject: "owner-personal" },
          gitIdentity: { name: "Personal Committer", email: "personal@example.test" },
        })
        const personalCheckout = {
          ownerId: "owner-personal",
          projectId: "project-personal",
          repositoryId: "99",
          installationId: "42",
          owner: "octo-org",
          name: "private-repo",
          ref: "main",
          commitSha: "a".repeat(40),
          private: true,
          gitIdentity: { name: "Personal Committer", email: "personal@example.test" },
        }
        yield* Effect.tryPromise(() =>
          pool.query(`INSERT INTO rika_hosted_workspaces
              (id, owner_id, project_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
              VALUES ('workspace-personal', 'owner-personal', 'project-personal', 'user-1', 'orb', true, now());
            INSERT INTO rika_hosted_threads
              (id, owner_id, project_id, workspace_id, created_by_user_id, executor_kind,
                inherit_project_grants, created_at)
              VALUES ('thread-personal', 'owner-personal', 'project-personal', 'workspace-personal',
                'user-1', 'orb', true, now())`),
        )
        yield* Effect.tryPromise(() =>
          pool.query(
            `INSERT INTO rika_hosted_executor_assignments
              (id, owner_id, thread_id, workspace_id, executor_kind, placement, checkout, generation, revision,
                last_lease_epoch, lifecycle, provider_instance_id, executor_instance_id, process_incarnation,
                session_digest, lease_epoch, lease_expires_at)
              VALUES ('assignment-personal', 'owner-personal', 'thread-personal', 'workspace-personal', 'orb',
                '{"_tag":"OrbPlacement","templateBuildId":"build-personal"}'::jsonb, $1::jsonb,
                1, 1, 1, 'active', 'provider-personal', 'executor-personal', 'process-personal',
                'session-personal', 1, now() + interval '5 minutes')`,
            [personalCheckout],
          ),
        )
        yield* Effect.tryPromise(() =>
          pool.query(`INSERT INTO rika_hosted_workspace_preparations
              (assignment_id, owner_id, workspace_id, generation, lease_epoch, attempt, state, phase,
                evidence, deadline_at, started_at, updated_at)
              VALUES ('assignment-personal', 'owner-personal', 'workspace-personal', 1, 1, 1, 'ready',
                'capabilities', '{}'::jsonb, now() + interval '5 minutes', now(), now())`),
        )
        const publication = yield* service.approvePublication({
          ownerId: "owner-personal",
          threadId: "thread-personal",
          actor: {
            _tag: "PersonalActor",
            owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make("user-1") },
            userId: BetterAuthUserId.make("user-1"),
            clientId: ClientId.make("client-personal"),
            deviceId: DeviceId.make("device-personal"),
          },
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
          commitSha: "c".repeat(40),
          title: "Publish personal Thread",
          body: "Approved publication",
        })
        expect(publication).toMatchObject({
          state: "approved",
          ownerId: "owner-personal",
          threadId: "thread-personal",
          sourceRef: "refs/heads/rika/thread-personal",
          sourceCommitSha: "c".repeat(40),
          authorizationCheckpointId: publication.id,
        })
        expect(publication.authorizationDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
        const evidence = yield* Effect.tryPromise(() =>
          pool.query(
            `SELECT assignment.latest_checkpoint_id, audit.authority, audit.fence, audit.result
            FROM rika_hosted_repository_publications publication
            JOIN rika_hosted_executor_assignments assignment ON assignment.id = publication.assignment_id
            JOIN rika_hosted_repository_publication_audit audit ON audit.publication_id = publication.id
            WHERE publication.id = $1`,
            [publication.id],
          ),
        )
        expect(evidence.rows[0]).toMatchObject({
          latest_checkpoint_id: null,
          authority: { ownerId: "owner-personal", sourceRef: "refs/heads/rika/thread-personal" },
          fence: {
            assignmentId: "assignment-personal",
            authorizationCheckpointId: publication.id,
            authorizationDigest: publication.authorizationDigest,
          },
          result: { outcome: "approved", purpose: "branch-push" },
        })
        yield* Effect.tryPromise(() =>
          pool.query(`UPDATE rika_hosted_repository_publications SET source_commit_sha = $1 WHERE id = $2`, [
            "d".repeat(40),
            publication.id,
          ]),
        ).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Effect.die("publication authority mutation unexpectedly succeeded"),
          }),
        )
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
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }).pipe(Effect.scoped, livePlatform),
)
