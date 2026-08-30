import * as PgDrizzle from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { and, eq, exists, gt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { AssignmentLeaseEpoch, FencingGeneration } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorAssignments,
  rikaHostedGitIdentities,
  rikaHostedProjectRepositories,
  rikaHostedProjects,
  rikaHostedRepositoryPublications,
  rikaHostedWorkspacePreparations,
} from "../../database/schema/product"
import { PublicationRows } from "./publication-rows"

export type PublicationState = "approved" | "pushing" | "pushed" | "completed" | "failed" | "unknown"
export type JsonObject = Readonly<Record<string, Schema.Json>>

export class RepositoryStoreError extends Schema.TaggedError<RepositoryStoreError>()("RepositoryStoreError", {
  reason: Schema.Literals(["authorization", "configuration", "database", "stale-fence"]),
  message: Schema.String,
}) {}

export interface RepositoryBinding {
  readonly projectId: string
  readonly ownerId: string
  readonly repositoryId: string
  readonly installationId: string
  readonly accountId: string
  readonly accountLogin: string
  readonly accountType: string
  readonly repositoryOwner: string
  readonly repositoryName: string
  readonly defaultRef: string
  readonly private: boolean
  readonly gitName: string
  readonly gitEmail: string
}

export interface Publication {
  readonly id: string
  readonly idempotencyKey: string
  readonly actor: Schema.Json
  readonly ownerId: string
  readonly threadId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly assignmentId: string
  readonly assignmentGeneration: FencingGeneration
  readonly leaseEpoch: AssignmentLeaseEpoch
  readonly workspaceId: string
  readonly authorizationCheckpointId: string
  readonly authorizationDigest: string
  readonly sourceBranch: string
  readonly sourceRef: string
  readonly sourceCommitSha: string
  readonly targetRef: string
  readonly targetCommitSha: string
  readonly targetProtected: boolean
  readonly title: string
  readonly body: string
  readonly state: PublicationState
  readonly pushResult: object | null
  readonly pullRequestResult: object | null
}

export interface PublicationFence {
  readonly projectId: string
  readonly repositoryId: string
  readonly checkoutProjectId: string
  readonly assignmentId: string
  readonly assignmentGeneration: FencingGeneration
  readonly leaseEpoch: AssignmentLeaseEpoch
  readonly workspaceId: string
}

export interface PublicationAccess {
  readonly assignmentGeneration: FencingGeneration
  readonly leaseEpoch: AssignmentLeaseEpoch
  readonly providerInstanceId: string
  readonly executorInstanceId: string
  readonly processIncarnation: string
  readonly sessionDigest: string
}

export type PublicationTransition = Omit<Publication, "actor" | "idempotencyKey">

export interface RepositoryStoreService {
  readonly loadBinding: (ownerId: string, projectId: string) => Effect.Effect<RepositoryBinding, RepositoryStoreError>
  readonly saveBinding: (
    input: Omit<RepositoryBinding, "gitName" | "gitEmail"> & { readonly gitName: string; readonly gitEmail: string },
  ) => Effect.Effect<void, RepositoryStoreError>
  readonly projectBelongsTo: (projectId: string, ownerId: string) => Effect.Effect<boolean, RepositoryStoreError>
  readonly findPublication: (
    ownerId: string,
    threadId: string,
    idempotencyKey: string,
  ) => Effect.Effect<Publication | undefined, RepositoryStoreError>
  readonly loadPublicationFence: (
    ownerId: string,
    threadId: string,
  ) => Effect.Effect<PublicationFence | undefined, RepositoryStoreError>
  readonly createPublication: (
    input: Publication & {
      readonly authority: JsonObject
      readonly fence: JsonObject
      readonly auditResult: JsonObject
    },
  ) => Effect.Effect<Publication, RepositoryStoreError>
  readonly claimPush: (input: {
    readonly publicationId: string
    readonly ownerId: string
    readonly repositoryId: string
    readonly workspaceId: string
    readonly branch: string
    readonly ref: string
    readonly commitSha: string
    readonly access: PublicationAccess
  }) => Effect.Effect<Publication, RepositoryStoreError>
  readonly failCredential: (publication: Publication) => Effect.Effect<void>
  readonly recordPush: (
    publication: PublicationTransition,
    result: JsonObject,
    state: "pushed" | "failed" | "unknown",
  ) => Effect.Effect<Publication, RepositoryStoreError>
  readonly recordPullRequest: (
    publication: PublicationTransition,
    result: JsonObject,
    succeeded: boolean,
  ) => Effect.Effect<Publication, RepositoryStoreError>
}

export class RepositoryStore extends Context.Service<RepositoryStore, RepositoryStoreService>()(
  "@rika/product-store/hosted/repository/store/RepositoryStore",
) {}

const failure = (reason: RepositoryStoreError["reason"], message: string) =>
  RepositoryStoreError.make({ reason, message })
const database =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => failure("database", message)))
const make = Effect.gen(function* () {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()
  const publicationFields = PublicationRows.fields
  const loadBinding: RepositoryStoreService["loadBinding"] = (ownerId, projectId) =>
    db
      .select({
        projectId: rikaHostedProjectRepositories.projectId,
        ownerId: rikaHostedProjectRepositories.ownerId,
        repositoryId: rikaHostedProjectRepositories.repositoryId,
        installationId: rikaHostedProjectRepositories.installationId,
        accountId: rikaHostedProjectRepositories.installationAccountId,
        accountLogin: rikaHostedProjectRepositories.installationAccountLogin,
        accountType: rikaHostedProjectRepositories.installationAccountType,
        repositoryOwner: rikaHostedProjectRepositories.repositoryOwner,
        repositoryName: rikaHostedProjectRepositories.repositoryName,
        defaultRef: rikaHostedProjectRepositories.defaultRef,
        private: rikaHostedProjectRepositories.private,
        gitName: rikaHostedGitIdentities.name,
        gitEmail: rikaHostedGitIdentities.email,
      })
      .from(rikaHostedProjectRepositories)
      .innerJoin(rikaHostedGitIdentities, eq(rikaHostedGitIdentities.ownerId, rikaHostedProjectRepositories.ownerId))
      .where(
        and(eq(rikaHostedProjectRepositories.ownerId, ownerId), eq(rikaHostedProjectRepositories.projectId, projectId)),
      )
      .pipe(
        database("Could not load the authorized Project repository"),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(failure("configuration", "Project does not have an authorized repository and Git identity"))
            : Effect.succeed(rows[0]),
        ),
      )
  const projectBelongsTo: RepositoryStoreService["projectBelongsTo"] = (projectId, ownerId) =>
    db
      .select({ id: rikaHostedProjects.id })
      .from(rikaHostedProjects)
      .where(and(eq(rikaHostedProjects.id, projectId), eq(rikaHostedProjects.ownerId, ownerId)))
      .pipe(
        database("Could not authorize the Project repository"),
        Effect.map((rows) => rows[0] !== undefined),
      )
  const saveBinding: RepositoryStoreService["saveBinding"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(rikaHostedGitIdentities)
            .values({
              ownerId: input.ownerId,
              name: input.gitName,
              email: input.gitEmail,
              updatedAt: sql`transaction_timestamp()`,
            })
            .onConflictDoUpdate({
              target: rikaHostedGitIdentities.ownerId,
              set: { name: input.gitName, email: input.gitEmail, updatedAt: sql`transaction_timestamp()` },
            })
          yield* tx
            .insert(rikaHostedProjectRepositories)
            .values({
              projectId: input.projectId,
              ownerId: input.ownerId,
              repositoryId: input.repositoryId,
              installationId: input.installationId,
              installationAccountId: input.accountId,
              installationAccountLogin: input.accountLogin,
              installationAccountType: input.accountType,
              repositoryOwner: input.repositoryOwner,
              repositoryName: input.repositoryName,
              defaultRef: input.defaultRef,
              private: input.private,
              createdAt: sql`transaction_timestamp()`,
              updatedAt: sql`transaction_timestamp()`,
            })
            .onConflictDoUpdate({
              target: rikaHostedProjectRepositories.projectId,
              set: {
                repositoryId: input.repositoryId,
                installationId: input.installationId,
                installationAccountId: input.accountId,
                installationAccountLogin: input.accountLogin,
                installationAccountType: input.accountType,
                repositoryOwner: input.repositoryOwner,
                repositoryName: input.repositoryName,
                defaultRef: input.defaultRef,
                private: input.private,
                updatedAt: sql`transaction_timestamp()`,
              },
            })
        }),
      )
      .pipe(database("Could not persist the authorized Project repository"))
  const { findPublication, loadPublicationFence } = PublicationRows.queries(db, failure)
  const createPublication: RepositoryStoreService["createPublication"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const live = yield* tx
            .select({ id: rikaHostedExecutorAssignments.id })
            .from(rikaHostedExecutorAssignments)
            .innerJoin(
              rikaHostedWorkspacePreparations,
              and(
                eq(rikaHostedWorkspacePreparations.assignmentId, rikaHostedExecutorAssignments.id),
                eq(rikaHostedWorkspacePreparations.ownerId, rikaHostedExecutorAssignments.ownerId),
                eq(rikaHostedWorkspacePreparations.generation, rikaHostedExecutorAssignments.generation),
                eq(rikaHostedWorkspacePreparations.workspaceId, rikaHostedExecutorAssignments.workspaceId),
                eq(rikaHostedWorkspacePreparations.leaseEpoch, rikaHostedExecutorAssignments.leaseEpoch),
                eq(rikaHostedWorkspacePreparations.state, "ready"),
              ),
            )
            .innerJoin(
              rikaHostedProjectRepositories,
              and(
                eq(rikaHostedProjectRepositories.projectId, input.projectId),
                eq(rikaHostedProjectRepositories.ownerId, rikaHostedExecutorAssignments.ownerId),
                eq(rikaHostedProjectRepositories.repositoryId, input.repositoryId),
              ),
            )
            .where(
              and(
                eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                eq(rikaHostedExecutorAssignments.ownerId, input.ownerId),
                eq(rikaHostedExecutorAssignments.threadId, input.threadId),
                eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                eq(rikaHostedExecutorAssignments.generation, Number(input.assignmentGeneration)),
                eq(rikaHostedExecutorAssignments.leaseEpoch, Number(input.leaseEpoch)),
                eq(rikaHostedExecutorAssignments.workspaceId, input.workspaceId),
                gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
                sql`${rikaHostedExecutorAssignments.checkout} ->> 'ownerId' = ${rikaHostedExecutorAssignments.ownerId}`,
                sql`${rikaHostedExecutorAssignments.checkout} ->> 'projectId' = ${input.projectId}`,
                sql`${rikaHostedExecutorAssignments.checkout} ->> 'repositoryId' = ${input.repositoryId}`,
                sql`${rikaHostedExecutorAssignments.checkout} ->> 'installationId' = ${rikaHostedProjectRepositories.installationId}`,
              ),
            )
          if (live[0] === undefined)
            return yield* failure("stale-fence", "Publication assignment changed before approval")
          const rows = yield* tx
            .insert(rikaHostedRepositoryPublications)
            .values({
              id: input.id,
              idempotencyKey: input.idempotencyKey,
              ownerId: input.ownerId,
              threadId: input.threadId,
              projectId: input.projectId,
              repositoryId: input.repositoryId,
              actor: input.actor,
              assignmentId: input.assignmentId,
              assignmentGeneration: Number(input.assignmentGeneration),
              leaseEpoch: Number(input.leaseEpoch),
              workspaceId: input.workspaceId,
              authorizationCheckpointId: input.authorizationCheckpointId,
              authorizationDigest: input.authorizationDigest,
              sourceBranch: input.sourceBranch,
              sourceRef: input.sourceRef,
              sourceCommitSha: input.sourceCommitSha,
              targetRef: input.targetRef,
              targetCommitSha: input.targetCommitSha,
              targetProtected: input.targetProtected,
              pullRequestTitle: input.title,
              pullRequestBody: input.body,
              state: "approved",
              approvedAt: sql`transaction_timestamp()`,
              updatedAt: sql`transaction_timestamp()`,
            })
            .onConflictDoNothing()
            .returning(publicationFields)
          const created = rows[0]
          if (created === undefined)
            return yield* failure("stale-fence", "Publication assignment changed before approval")
          yield* PublicationRows.auditApproval(tx, created, input.authority, input.fence, input.auditResult)
          return created
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(RepositoryStoreError)(error)
            ? error
            : failure("database", "Could not persist the publication approval"),
        ),
      )
  const claimPush: RepositoryStoreService["claimPush"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const validAssignment = exists(
            tx
              .select({ id: rikaHostedExecutorAssignments.id })
              .from(rikaHostedExecutorAssignments)
              .innerJoin(
                rikaHostedWorkspacePreparations,
                and(
                  eq(rikaHostedWorkspacePreparations.assignmentId, rikaHostedExecutorAssignments.id),
                  eq(rikaHostedWorkspacePreparations.ownerId, rikaHostedExecutorAssignments.ownerId),
                  eq(rikaHostedWorkspacePreparations.workspaceId, rikaHostedExecutorAssignments.workspaceId),
                  eq(rikaHostedWorkspacePreparations.generation, rikaHostedExecutorAssignments.generation),
                  eq(rikaHostedWorkspacePreparations.leaseEpoch, rikaHostedExecutorAssignments.leaseEpoch),
                  eq(rikaHostedWorkspacePreparations.state, "ready"),
                ),
              )
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, rikaHostedRepositoryPublications.assignmentId),
                  eq(rikaHostedExecutorAssignments.ownerId, rikaHostedRepositoryPublications.ownerId),
                  eq(rikaHostedExecutorAssignments.threadId, rikaHostedRepositoryPublications.threadId),
                  eq(rikaHostedExecutorAssignments.workspaceId, rikaHostedRepositoryPublications.workspaceId),
                  eq(rikaHostedExecutorAssignments.generation, Number(input.access.assignmentGeneration)),
                  eq(rikaHostedExecutorAssignments.generation, rikaHostedRepositoryPublications.assignmentGeneration),
                  eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                  eq(rikaHostedExecutorAssignments.providerInstanceId, input.access.providerInstanceId),
                  eq(rikaHostedExecutorAssignments.executorInstanceId, input.access.executorInstanceId),
                  eq(rikaHostedExecutorAssignments.processIncarnation, input.access.processIncarnation),
                  eq(rikaHostedExecutorAssignments.leaseEpoch, Number(input.access.leaseEpoch)),
                  eq(rikaHostedExecutorAssignments.leaseEpoch, rikaHostedRepositoryPublications.leaseEpoch),
                  gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
                  eq(rikaHostedExecutorAssignments.sessionDigest, input.access.sessionDigest),
                  sql`${rikaHostedExecutorAssignments.checkout} ->> 'ownerId' = ${rikaHostedRepositoryPublications.ownerId}`,
                  sql`${rikaHostedExecutorAssignments.checkout} ->> 'projectId' = ${rikaHostedRepositoryPublications.projectId}`,
                  sql`${rikaHostedExecutorAssignments.checkout} ->> 'repositoryId' = ${rikaHostedRepositoryPublications.repositoryId}`,
                ),
              ),
          )
          const rows = yield* tx
            .update(rikaHostedRepositoryPublications)
            .set({
              state: "pushing",
              credentialAuthorizedAt: sql`transaction_timestamp()`,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(
              and(
                eq(rikaHostedRepositoryPublications.id, input.publicationId),
                eq(rikaHostedRepositoryPublications.state, "approved"),
                sql`${rikaHostedRepositoryPublications.credentialAuthorizedAt} is null`,
                eq(rikaHostedRepositoryPublications.ownerId, input.ownerId),
                eq(rikaHostedRepositoryPublications.repositoryId, input.repositoryId),
                eq(rikaHostedRepositoryPublications.workspaceId, input.workspaceId),
                eq(rikaHostedRepositoryPublications.sourceBranch, input.branch),
                eq(rikaHostedRepositoryPublications.sourceRef, input.ref),
                eq(rikaHostedRepositoryPublications.sourceCommitSha, input.commitSha),
                validAssignment,
              ),
            )
            .returning(publicationFields)
          const p = rows[0]
          if (p === undefined)
            return yield* failure("authorization", "Branch push approval is stale or does not match this operation")
          yield* PublicationRows.audit(tx, p, "branch-push-credential-authorized", {
            purpose: "branch-push",
            permissions: { contents: "write" },
          })
          return p
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(RepositoryStoreError)(error)
            ? error
            : failure("database", "Could not claim the branch push approval"),
        ),
      )
  const failCredential = PublicationRows.failCredential(db)
  const recordPush: RepositoryStoreService["recordPush"] = (p, result, state) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .update(rikaHostedRepositoryPublications)
            .set({ state, pushResult: result, updatedAt: sql`transaction_timestamp()` })
            .where(
              and(
                eq(rikaHostedRepositoryPublications.id, p.id),
                eq(rikaHostedRepositoryPublications.state, "pushing"),
                eq(rikaHostedRepositoryPublications.ownerId, p.ownerId),
                eq(rikaHostedRepositoryPublications.threadId, p.threadId),
                eq(rikaHostedRepositoryPublications.repositoryId, p.repositoryId),
                eq(rikaHostedRepositoryPublications.assignmentId, p.assignmentId),
                eq(rikaHostedRepositoryPublications.assignmentGeneration, Number(p.assignmentGeneration)),
                eq(rikaHostedRepositoryPublications.leaseEpoch, Number(p.leaseEpoch)),
                eq(rikaHostedRepositoryPublications.workspaceId, p.workspaceId),
                eq(rikaHostedRepositoryPublications.authorizationCheckpointId, p.authorizationCheckpointId),
                eq(rikaHostedRepositoryPublications.authorizationDigest, p.authorizationDigest),
                eq(rikaHostedRepositoryPublications.sourceBranch, p.sourceBranch),
                eq(rikaHostedRepositoryPublications.sourceCommitSha, p.sourceCommitSha),
              ),
            )
            .returning(publicationFields)
          const next = rows[0]
          if (next === undefined) return yield* failure("authorization", "Publication push result is stale")
          let action = "branch-push-failed"
          if (state === "pushed") action = "branch-push-succeeded"
          if (state === "unknown") action = "branch-push-unknown"
          yield* PublicationRows.audit(tx, next, action, result)
          return next
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(RepositoryStoreError)(error)
            ? error
            : failure("database", "Could not record the publication push result"),
        ),
      )
  const recordPullRequest: RepositoryStoreService["recordPullRequest"] = (p, result, succeeded) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .update(rikaHostedRepositoryPublications)
            .set({
              state: succeeded ? "completed" : "failed",
              pullRequestResult: result,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(
              and(
                eq(rikaHostedRepositoryPublications.id, p.id),
                eq(rikaHostedRepositoryPublications.state, "pushed"),
                eq(rikaHostedRepositoryPublications.sourceCommitSha, p.sourceCommitSha),
                eq(rikaHostedRepositoryPublications.targetRef, p.targetRef),
                eq(rikaHostedRepositoryPublications.targetCommitSha, p.targetCommitSha),
              ),
            )
            .returning(publicationFields)
          const next = rows[0]
          if (next === undefined) return yield* failure("authorization", "Pull request result is stale")
          yield* PublicationRows.audit(tx, next, succeeded ? "pull-request-succeeded" : "pull-request-failed", result)
          return next
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(RepositoryStoreError)(error)
            ? error
            : failure("database", "Could not record the pull request result"),
        ),
      )
  return RepositoryStore.of({
    loadBinding,
    saveBinding,
    projectBelongsTo,
    findPublication,
    loadPublicationFence,
    createPublication,
    claimPush,
    failCredential,
    recordPush,
    recordPullRequest,
  })
})

export const layer = Layer.effect(RepositoryStore, make)
