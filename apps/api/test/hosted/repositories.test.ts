import * as PgClient from "@effect/sql-pg/PgClient"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { installationTestLayer } from "@rika/github-app/installation-service"
import { InstallationToken } from "@rika/github-app/installation-token"
import { identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import { BetterAuthUserId, ClientId, DeviceId } from "@rika/product/hosted-model"
import {
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedRepositoryPublicationAudit,
  rikaHostedRepositoryPublications,
  rikaHostedThreads,
  rikaHostedWorkspacePreparations,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as assignmentLayer } from "@rika/product-store/assignments"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { FileSystem, Config, Clock, Context, DateTime, Effect, Layer, Random, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Pool } from "pg"
import { live as livePlatform } from "../support/live-platform"
import { HostedRepositories, layer as repositoryLayer } from "../../src/hosted/repositories"

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
        const databaseClient = drizzle({ client: pool })
        const currentDateTime = DateTime.nowUnsafe()
        const createdAt = DateTime.toDate(currentDateTime)
        const expiresAt = DateTime.toDate(DateTime.add(currentDateTime, { minutes: 5 }))
        yield* Effect.tryPromise(() =>
          databaseClient.insert(identityUser).values({
            id: "user-1",
            name: "User",
            email: "user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(identityOrganization).values({
            id: "organization-1",
            name: "Organization",
            slug: "organization",
            createdAt,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient
            .insert(rikaHostedOwners)
            .values({ id: "owner-1", kind: "organization", organizationId: "organization-1" }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedProjects).values({
            id: "project-1",
            ownerId: "owner-1",
            name: "Project",
            createdByUserId: "user-1",
            createdAt,
            updatedAt: createdAt,
          }),
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
        const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })
        const dependencies = Layer.mergeAll(
          BunCrypto.layer,
          postgres,
          assignmentLayer.pipe(Layer.provide(postgres)),
          installationLayer,
          tokenLayer,
          httpLayer,
        )
        const context = yield* Layer.build(
          repositoryLayer({ baseUrl: "https://github.test" }).pipe(Layer.provide(dependencies)),
        )
        const service = Context.get(context, HostedRepositories)
        const postgresContext = yield* Layer.build(postgres)
        const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(postgresContext))
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
          databaseClient.insert(rikaHostedOwners).values({ id: "owner-personal", kind: "personal", userId: "user-1" }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedProjects).values({
            id: "project-personal",
            ownerId: "owner-personal",
            name: "Personal Project",
            createdByUserId: "user-1",
            createdAt,
            updatedAt: createdAt,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedDevices).values({
            id: "device-personal",
            userId: "user-1",
            displayName: "Personal Device",
            publicKeyFingerprint: "fingerprint-personal",
            createdAt,
            lastSeenAt: createdAt,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedClients).values({
            id: "client-personal",
            userId: "user-1",
            deviceId: "device-personal",
            authenticatedAt: createdAt,
            lastSeenAt: createdAt,
            expiresAt,
          }),
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
        yield* aggregateDatabase.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(rikaHostedWorkspaces).values({
              id: "workspace-personal",
              ownerId: "owner-personal",
              projectId: "project-personal",
              createdByUserId: "user-1",
              executorKind: "orb",
              inheritProjectGrants: true,
              createdAt,
            })
            yield* tx
              .insert(rikaWorkspaces)
              .values({ ownerId: "owner-personal", path: "workspace-personal", createdAt: 1 })
            yield* tx.insert(rikaHostedThreads).values({
              id: "thread-personal",
              ownerId: "owner-personal",
              projectId: "project-personal",
              workspaceId: "workspace-personal",
              createdByUserId: "user-1",
              executorKind: "orb",
              inheritProjectGrants: true,
              createdAt,
            })
            yield* tx.insert(rikaThreads).values({
              id: "thread-personal",
              ownerId: "owner-personal",
              workspace: "workspace-personal",
              title: "Personal",
              createdAt: 1,
              updatedAt: 1,
            })
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedExecutorAssignments).values({
            id: "assignment-personal",
            ownerId: "owner-personal",
            threadId: "thread-personal",
            workspaceId: "workspace-personal",
            executorKind: "orb",
            placement: { _tag: "OrbPlacement", templateBuildId: "build-personal" },
            checkout: personalCheckout,
            generation: 1,
            revision: 1,
            lastLeaseEpoch: 1,
            lifecycle: "active",
            providerInstanceId: "provider-personal",
            executorInstanceId: "executor-personal",
            processIncarnation: "process-personal",
            sessionDigest: "session-personal",
            leaseEpoch: 1,
            leaseExpiresAt: expiresAt,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedWorkspacePreparations).values({
            assignmentId: "assignment-personal",
            ownerId: "owner-personal",
            workspaceId: "workspace-personal",
            generation: 1,
            leaseEpoch: 1,
            attempt: 1,
            state: "ready",
            phase: "capabilities",
            evidence: {},
            deadlineAt: expiresAt,
            startedAt: createdAt,
            updatedAt: createdAt,
          }),
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
          databaseClient
            .select({
              latest_checkpoint_id: rikaHostedExecutorAssignments.latestCheckpointId,
              authority: rikaHostedRepositoryPublicationAudit.authority,
              fence: rikaHostedRepositoryPublicationAudit.fence,
              result: rikaHostedRepositoryPublicationAudit.result,
            })
            .from(rikaHostedRepositoryPublications)
            .innerJoin(
              rikaHostedExecutorAssignments,
              eq(rikaHostedExecutorAssignments.id, rikaHostedRepositoryPublications.assignmentId),
            )
            .innerJoin(
              rikaHostedRepositoryPublicationAudit,
              eq(rikaHostedRepositoryPublicationAudit.publicationId, rikaHostedRepositoryPublications.id),
            )
            .where(eq(rikaHostedRepositoryPublications.id, publication.id)),
        )
        expect(evidence[0]).toMatchObject({
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
          databaseClient
            .update(rikaHostedRepositoryPublications)
            .set({ sourceCommitSha: "d".repeat(40) })
            .where(eq(rikaHostedRepositoryPublications.id, publication.id)),
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
