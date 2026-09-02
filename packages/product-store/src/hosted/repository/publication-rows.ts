import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, eq, gt, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { AssignmentLeaseEpoch, FencingGeneration } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorAssignments,
  rikaHostedProjectRepositories,
  rikaHostedRepositoryPublicationAudit,
  rikaHostedRepositoryPublications,
  rikaHostedThreads,
  rikaHostedWorkspacePreparations,
} from "../../database/schema/product"
import type { JsonObject, Publication, RepositoryStoreError, RepositoryStoreService } from "./store"

type Failure = (reason: RepositoryStoreError["reason"], message: string) => RepositoryStoreError

const publicationFields = {
  id: rikaHostedRepositoryPublications.id,
  idempotencyKey: rikaHostedRepositoryPublications.idempotencyKey,
  actor: sql<Schema.Json>`${rikaHostedRepositoryPublications.actor}`,
  ownerId: rikaHostedRepositoryPublications.ownerId,
  threadId: rikaHostedRepositoryPublications.threadId,
  projectId: rikaHostedRepositoryPublications.projectId,
  repositoryId: rikaHostedRepositoryPublications.repositoryId,
  assignmentId: rikaHostedRepositoryPublications.assignmentId,
  assignmentGeneration: sql<FencingGeneration>`${rikaHostedRepositoryPublications.assignmentGeneration}::text`,
  leaseEpoch: sql<AssignmentLeaseEpoch>`${rikaHostedRepositoryPublications.leaseEpoch}::text`,
  workspaceId: rikaHostedRepositoryPublications.workspaceId,
  authorizationCheckpointId: rikaHostedRepositoryPublications.authorizationCheckpointId,
  authorizationDigest: rikaHostedRepositoryPublications.authorizationDigest,
  sourceBranch: rikaHostedRepositoryPublications.sourceBranch,
  sourceRef: rikaHostedRepositoryPublications.sourceRef,
  sourceCommitSha: rikaHostedRepositoryPublications.sourceCommitSha,
  targetRef: rikaHostedRepositoryPublications.targetRef,
  targetCommitSha: rikaHostedRepositoryPublications.targetCommitSha,
  targetProtected: rikaHostedRepositoryPublications.targetProtected,
  title: rikaHostedRepositoryPublications.pullRequestTitle,
  body: rikaHostedRepositoryPublications.pullRequestBody,
  state: rikaHostedRepositoryPublications.state,
  pushResult: sql<object | null>`${rikaHostedRepositoryPublications.pushResult}`,
  pullRequestResult: sql<object | null>`${rikaHostedRepositoryPublications.pullRequestResult}`,
}

const authority = (publication: Publication) => ({
  ownerId: publication.ownerId,
  threadId: publication.threadId,
  projectId: publication.projectId,
  repositoryId: publication.repositoryId,
  sourceBranch: publication.sourceBranch,
  sourceRef: publication.sourceRef,
  sourceCommitSha: publication.sourceCommitSha,
  targetRef: publication.targetRef,
  targetCommitSha: publication.targetCommitSha,
  targetProtected: publication.targetProtected,
})

const fence = (publication: Publication) => ({
  assignmentId: publication.assignmentId,
  assignmentGeneration: publication.assignmentGeneration,
  leaseEpoch: publication.leaseEpoch,
  workspaceId: publication.workspaceId,
  authorizationCheckpointId: publication.authorizationCheckpointId,
  authorizationDigest: publication.authorizationDigest,
})

const auditPublication = (
  tx: PgDrizzle.EffectPgDatabase,
  publication: Publication,
  action: string,
  result: JsonObject,
) =>
  tx.insert(rikaHostedRepositoryPublicationAudit).values({
    publicationId: publication.id,
    ownerId: publication.ownerId,
    threadId: publication.threadId,
    actor: publication.actor,
    action,
    authority: authority(publication),
    fence: fence(publication),
    result,
  })

const auditApproval = (
  tx: PgDrizzle.EffectPgDatabase,
  publication: Publication,
  approvalAuthority: JsonObject,
  approvalFence: JsonObject,
  result: JsonObject,
) =>
  tx.insert(rikaHostedRepositoryPublicationAudit).values({
    publicationId: publication.id,
    ownerId: publication.ownerId,
    threadId: publication.threadId,
    actor: publication.actor,
    action: "approved",
    authority: approvalAuthority,
    fence: approvalFence,
    result,
  })

const publicationQueries = (db: PgDrizzle.EffectPgDatabase, failure: Failure) => {
  const database =
    (message: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError(() => failure("database", message)))
  const findPublication: RepositoryStoreService["findPublication"] = (ownerId, threadId, idempotencyKey) =>
    db
      .select(publicationFields)
      .from(rikaHostedRepositoryPublications)
      .where(
        and(
          eq(rikaHostedRepositoryPublications.ownerId, ownerId),
          eq(rikaHostedRepositoryPublications.threadId, threadId),
          eq(rikaHostedRepositoryPublications.idempotencyKey, idempotencyKey),
        ),
      )
      .pipe(
        database("Could not inspect the publication approval"),
        Effect.map((rows) => rows[0]),
      )
  const loadPublicationFence: RepositoryStoreService["loadPublicationFence"] = (ownerId, threadId) =>
    db
      .select({
        projectId: rikaHostedThreads.projectId,
        repositoryId: rikaHostedProjectRepositories.repositoryId,
        checkoutProjectId: sql<string>`${rikaHostedExecutorAssignments.checkout} ->> 'projectId'`,
        assignmentId: rikaHostedExecutorAssignments.id,
        assignmentGeneration: sql<FencingGeneration>`${rikaHostedExecutorAssignments.generation}::text`,
        leaseEpoch: sql<AssignmentLeaseEpoch>`${rikaHostedExecutorAssignments.leaseEpoch}::text`,
        workspaceId: rikaHostedExecutorAssignments.workspaceId,
      })
      .from(rikaHostedThreads)
      .innerJoin(
        rikaHostedExecutorAssignments,
        and(
          eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id),
          eq(rikaHostedExecutorAssignments.ownerId, rikaHostedThreads.ownerId),
        ),
      )
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
          eq(rikaHostedProjectRepositories.projectId, rikaHostedThreads.projectId),
          eq(rikaHostedProjectRepositories.ownerId, rikaHostedThreads.ownerId),
        ),
      )
      .where(
        and(
          eq(rikaHostedThreads.id, threadId),
          eq(rikaHostedThreads.ownerId, ownerId),
          eq(rikaHostedThreads.executorKind, "orb"),
          eq(rikaHostedExecutorAssignments.lifecycle, "active"),
          gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
          sql`${rikaHostedExecutorAssignments.checkout} ->> 'ownerId' = ${rikaHostedThreads.ownerId}`,
          sql`${rikaHostedExecutorAssignments.checkout} ->> 'repositoryId' = ${rikaHostedProjectRepositories.repositoryId}`,
        ),
      )
      .pipe(
        database("Could not load the publication fence"),
        Effect.map((rows) => {
          const row = rows[0]
          return row === undefined || row.projectId === null || row.leaseEpoch === null
            ? undefined
            : { ...row, projectId: row.projectId, leaseEpoch: row.leaseEpoch }
        }),
      )
  return { findPublication, loadPublicationFence }
}

const failCredential =
  (db: PgDrizzle.EffectPgDatabase): RepositoryStoreService["failCredential"] =>
  (publication) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .update(rikaHostedRepositoryPublications)
            .set({ state: "failed", updatedAt: sql`transaction_timestamp()` })
            .where(
              and(
                eq(rikaHostedRepositoryPublications.id, publication.id),
                eq(rikaHostedRepositoryPublications.state, "pushing"),
                eq(rikaHostedRepositoryPublications.authorizationDigest, publication.authorizationDigest),
              ),
            )
            .returning({ id: rikaHostedRepositoryPublications.id })
          if (rows[0] !== undefined)
            yield* auditPublication(tx, publication, "branch-push-credential-failed", {
              purpose: "branch-push",
              outcome: "failed",
            })
        }),
      )
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("repository-publication.fail-credential-persistence-failed").pipe(
            Effect.annotateLogs("rika.error.cause", String(cause)),
          ),
        ),
        Effect.ignore,
      )

export const PublicationRows = {
  audit: auditPublication,
  auditApproval,
  failCredential,
  fields: publicationFields,
  queries: publicationQueries,
}
