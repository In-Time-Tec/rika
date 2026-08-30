import { Context, Effect, Schema } from "effect"
import type {
  EncryptedEnvironmentValue,
  EnvironmentAuthorityContext,
  EnvironmentClassification,
  EnvironmentPhase,
  EnvironmentReference,
  EnvironmentReferenceId,
  EnvironmentScope,
  EnvironmentValueDigest,
  EnvironmentValueName,
  PhaseEgressPolicy,
  SourceEnvironmentApproval,
  SourceTrust,
  StoredEnvironmentCandidate,
} from "./policy"
import type { BetterAuthUserId, OwnerId, ProjectId } from "../model"

export class EnvironmentStoreError extends Schema.TaggedError<EnvironmentStoreError>()("EnvironmentStoreError", {
  kind: Schema.Literals(["conflict", "database", "forbidden", "invalid", "not-found"]),
  message: Schema.String,
}) {}

export interface PutEnvironmentValueInput extends EnvironmentAuthorityContext {
  readonly id: EnvironmentReferenceId
  readonly scope: EnvironmentScope
  readonly scopeId: string
  readonly name: EnvironmentValueName
  readonly classification: EnvironmentClassification
  readonly phases: ReadonlyArray<EnvironmentPhase>
  readonly valueDigest: EnvironmentValueDigest
  readonly encrypted: EncryptedEnvironmentValue
  readonly actorUserId: BetterAuthUserId
}

export interface RevokeEnvironmentValueInput extends EnvironmentAuthorityContext {
  readonly scope: EnvironmentScope
  readonly scopeId: string
  readonly name: EnvironmentValueName
  readonly actorUserId: BetterAuthUserId
}

export interface PutOrganizationEnvironmentPolicyInput {
  readonly ownerId: OwnerId
  readonly personalOverrides: boolean
  readonly actorUserId: BetterAuthUserId
}

export interface PutSourceEnvironmentApprovalInput {
  readonly ownerId: OwnerId
  readonly projectId?: ProjectId
  readonly sourceOwner: string
  readonly sourceCommitSha: string
  readonly phase: EnvironmentPhase
  readonly actorUserId: BetterAuthUserId
}

export type RevokeSourceEnvironmentApprovalInput = PutSourceEnvironmentApprovalInput

export interface PutPhaseEgressPolicyInput {
  readonly ownerId: OwnerId
  readonly projectId?: ProjectId
  readonly policy: PhaseEgressPolicy
  readonly actorUserId: BetterAuthUserId
}

export interface ResolvePhaseInput extends EnvironmentAuthorityContext {
  readonly phase: EnvironmentPhase
  readonly source: SourceTrust
}

export interface StoredPhaseEnvironment {
  readonly candidates: ReadonlyArray<StoredEnvironmentCandidate>
  readonly approval?: SourceEnvironmentApproval
  readonly organizationPersonalOverrides: boolean
  readonly egress: PhaseEgressPolicy
}

export interface EnvironmentStoreService {
  readonly putValue: (input: PutEnvironmentValueInput) => Effect.Effect<EnvironmentReference, EnvironmentStoreError>
  readonly revokeValue: (
    input: RevokeEnvironmentValueInput,
  ) => Effect.Effect<EnvironmentReference, EnvironmentStoreError>
  readonly putOrganizationPolicy: (
    input: PutOrganizationEnvironmentPolicyInput,
  ) => Effect.Effect<void, EnvironmentStoreError>
  readonly putApproval: (
    input: PutSourceEnvironmentApprovalInput,
  ) => Effect.Effect<SourceEnvironmentApproval, EnvironmentStoreError>
  readonly revokeApproval: (
    input: RevokeSourceEnvironmentApprovalInput,
  ) => Effect.Effect<SourceEnvironmentApproval, EnvironmentStoreError>
  readonly putEgress: (input: PutPhaseEgressPolicyInput) => Effect.Effect<PhaseEgressPolicy, EnvironmentStoreError>
  readonly resolvePhase: (input: ResolvePhaseInput) => Effect.Effect<StoredPhaseEnvironment, EnvironmentStoreError>
}

export class EnvironmentStore extends Context.Service<EnvironmentStore, EnvironmentStoreService>()(
  "@rika/product/hosted/environment/store/EnvironmentStore",
) {}
