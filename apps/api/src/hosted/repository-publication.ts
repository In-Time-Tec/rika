import type { Publication as StoredPublication, PublicationTransition } from "@rika/product-store/repositories"
import { Schema } from "effect"
import type { ActorAttribution } from "@rika/product/hosted-model"
import type { ApprovedPublication, HostedRepositoriesService } from "./repository-contract"

type CanonicalValue = Schema.Json | ActorAttribution

export const canonicalJson = (value: CanonicalValue): string => {
  if (Schema.is(Schema.Array(Schema.Json))(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (Schema.is(Schema.Record(Schema.String, Schema.Json))(value))
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export const toPublication = (row: StoredPublication): ApprovedPublication => ({
  id: row.id,
  ownerId: row.ownerId,
  threadId: row.threadId,
  projectId: row.projectId,
  repositoryId: row.repositoryId,
  assignmentId: row.assignmentId,
  assignmentGeneration: row.assignmentGeneration,
  leaseEpoch: row.leaseEpoch,
  workspaceId: row.workspaceId,
  authorizationCheckpointId: row.authorizationCheckpointId,
  authorizationDigest: row.authorizationDigest,
  sourceBranch: row.sourceBranch,
  sourceRef: row.sourceRef,
  sourceCommitSha: row.sourceCommitSha,
  target: { ref: row.targetRef, commitSha: row.targetCommitSha, protected: row.targetProtected },
  title: row.title,
  body: row.body,
  state: row.state,
  pushResult: row.pushResult,
  pullRequestResult: row.pullRequestResult,
})

export const toPublicationTransition = (publication: ApprovedPublication): PublicationTransition => ({
  ...publication,
  targetRef: publication.target.ref,
  targetCommitSha: publication.target.commitSha,
  targetProtected: publication.target.protected,
  title: publication.title,
  body: publication.body,
})

type ApprovalInput = Parameters<HostedRepositoriesService["approvePublication"]>[0]

export const normalizeApproval = (input: ApprovalInput) => ({
  idempotencyKey: input.idempotencyKey.trim(),
  sourceCommitSha: input.commitSha.toLowerCase(),
  requestedTargetRef: input.targetRef?.trim(),
  title: input.title.trim(),
  body: input.body,
})

type NormalizedApproval = ReturnType<typeof normalizeApproval>

export const isValidApproval = (approval: NormalizedApproval) =>
  approval.idempotencyKey.length > 0 &&
  /^[a-f0-9]{40}$/.test(approval.sourceCommitSha) &&
  (approval.requestedTargetRef === undefined ||
    (approval.requestedTargetRef.length > 0 && approval.requestedTargetRef.length <= 255)) &&
  approval.title.length > 0 &&
  approval.title.length <= 256 &&
  approval.body.length <= 65_536

export const isSameApproval = ({
  known,
  input,
  approval,
}: {
  known: StoredPublication
  input: ApprovalInput
  approval: NormalizedApproval
}) =>
  known.actor !== null &&
  canonicalJson(known.actor) === canonicalJson(input.actor) &&
  known.sourceCommitSha === approval.sourceCommitSha &&
  known.targetRef === (approval.requestedTargetRef || known.targetRef) &&
  known.title === approval.title &&
  known.body === approval.body
