import { Schema } from "effect"
import { Timestamp, type BetterAuthUserId, type OwnerId, type ProjectId } from "../model"

const OpaqueId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,255}$/))
const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const CommitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/i))

export const EnvironmentReferenceId = OpaqueId.pipe(Schema.brand("HostedEnvironmentReferenceId"))
export type EnvironmentReferenceId = typeof EnvironmentReferenceId.Type
export const EnvironmentPhase = Schema.Literals(["setup", "runtime"])
export type EnvironmentPhase = typeof EnvironmentPhase.Type
export const EnvironmentClassification = Schema.Literals(["plain", "secret"])
export type EnvironmentClassification = typeof EnvironmentClassification.Type
export const EnvironmentScope = Schema.Literals(["personal", "organization", "project"])
export type EnvironmentScope = typeof EnvironmentScope.Type
export const EnvironmentValueName = EnvironmentName
export type EnvironmentValueName = typeof EnvironmentValueName.Type
export const EnvironmentValueDigest = Sha256
export type EnvironmentValueDigest = typeof EnvironmentValueDigest.Type
export const SourceCommitSha = CommitSha
export type SourceCommitSha = typeof SourceCommitSha.Type

export const EnvironmentReference = Schema.Struct({
  id: EnvironmentReferenceId,
  ownerId: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  scope: EnvironmentScope,
  scopeId: Schema.String,
  name: EnvironmentName,
  classification: EnvironmentClassification,
  phases: Schema.Array(EnvironmentPhase),
  revision: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  valueDigest: Sha256,
  state: Schema.Literals(["active", "revoked"]),
  updatedByUserId: Schema.String,
  updatedAt: Timestamp,
})
export type EnvironmentReference = typeof EnvironmentReference.Type

export const SourceTrust = Schema.Struct({
  owner: Schema.NonEmptyString,
  commitSha: CommitSha,
  fork: Schema.Boolean,
  trustedRef: Schema.Boolean,
})
export type SourceTrust = typeof SourceTrust.Type

export const SourceEnvironmentApproval = Schema.Struct({
  ownerId: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  sourceOwner: Schema.NonEmptyString,
  sourceCommitSha: CommitSha,
  phase: EnvironmentPhase,
  approvedByUserId: Schema.String,
  approvedAt: Timestamp,
  revokedAt: Schema.NullOr(Timestamp),
})
export type SourceEnvironmentApproval = typeof SourceEnvironmentApproval.Type

export const PhaseEnvironmentManifest = Schema.Struct({
  phase: EnvironmentPhase,
  digest: Sha256,
  references: Schema.Array(EnvironmentReference),
})
export type PhaseEnvironmentManifest = typeof PhaseEnvironmentManifest.Type

export const PhaseEgressPolicy = Schema.Struct({
  phase: EnvironmentPhase,
  allow: Schema.Array(Schema.NonEmptyString),
})
export type PhaseEgressPolicy = typeof PhaseEgressPolicy.Type

export interface EnvironmentCandidate {
  readonly reference: EnvironmentReference
}

export interface ResolveEnvironmentInput {
  readonly candidates: ReadonlyArray<EnvironmentCandidate>
  readonly phase: EnvironmentPhase
  readonly source: SourceTrust
  readonly approval?: SourceEnvironmentApproval
  readonly organizationPersonalOverrides: boolean
}

const scopeRank = {
  organization: 1,
  project: 2,
  personal: 3,
} satisfies Readonly<Record<EnvironmentScope, number>>

export const sourceMayReceiveSecrets = (input: {
  readonly source: SourceTrust
  readonly phase: EnvironmentPhase
  readonly approval?: SourceEnvironmentApproval
  readonly ownerId?: string
}) => {
  const { source, phase, approval, ownerId } = input
  if (!source.fork && source.trustedRef) return true
  return (
    approval !== undefined &&
    (ownerId === undefined || approval.ownerId === ownerId) &&
    approval.revokedAt === null &&
    approval.sourceOwner.toLowerCase() === source.owner.toLowerCase() &&
    approval.sourceCommitSha.toLowerCase() === source.commitSha.toLowerCase() &&
    approval.phase === phase
  )
}

export const resolveEnvironmentReferences = (input: ResolveEnvironmentInput): ReadonlyArray<EnvironmentReference> => {
  const selected = new Map<string, EnvironmentReference>()
  const mayReceiveSecrets = (reference: EnvironmentReference) =>
    input.approval === undefined
      ? sourceMayReceiveSecrets({ source: input.source, phase: input.phase, ownerId: reference.ownerId })
      : sourceMayReceiveSecrets({
          source: input.source,
          phase: input.phase,
          approval: input.approval,
          ownerId: reference.ownerId,
        })
  const candidates = [...input.candidates]
    .map(({ reference }) => reference)
    .filter(
      (reference) =>
        reference.state === "active" &&
        reference.phases.includes(input.phase) &&
        (reference.classification === "plain" || mayReceiveSecrets(reference)),
    )
    .sort(
      (left, right) =>
        scopeRank[left.scope] - scopeRank[right.scope] ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
  for (const candidate of candidates) {
    const current = selected.get(candidate.name)
    if (
      candidate.scope === "personal" &&
      current !== undefined &&
      current.scope !== "personal" &&
      !input.organizationPersonalOverrides
    )
      continue
    if (current === undefined || scopeRank[candidate.scope] >= scopeRank[current.scope]) {
      selected.set(candidate.name, candidate)
    }
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name))
}

const forbiddenEgressSuffixes = [".e2b.app", ".e2b.dev", ".internal", ".local", ".localhost"] as const
const forbiddenEgressHosts = new Set([
  "0.0.0.0",
  "100.100.100.200",
  "169.254.169.254",
  "api.e2b.app",
  "api.e2b.dev",
  "localhost",
  "metadata.google.internal",
  "metadata.azure.internal",
])
const publicHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/
const ipv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/

export const normalizeEgressDestination = (input: {
  readonly destination: string
  readonly protectedHosts?: ReadonlySet<string>
}): string | undefined => {
  const { destination, protectedHosts = new Set() } = input
  const host = destination.trim().toLowerCase().replace(/\.$/, "")
  if (
    host.length === 0 ||
    host === "*" ||
    host.includes(":") ||
    host.includes("/") ||
    ipv4.test(host) ||
    !publicHostname.test(host) ||
    forbiddenEgressHosts.has(host) ||
    forbiddenEgressSuffixes.some((suffix) => host.endsWith(suffix)) ||
    [...protectedHosts].some((protectedHost) => host === protectedHost.toLowerCase())
  )
    return undefined
  return host
}

export const resolveEgressPolicy = (input: {
  readonly phase: EnvironmentPhase
  readonly approved: ReadonlyArray<string>
  readonly protectedHosts?: ReadonlySet<string>
}): PhaseEgressPolicy | undefined => {
  const allow = input.approved.map((destination) =>
    input.protectedHosts === undefined
      ? normalizeEgressDestination({ destination })
      : normalizeEgressDestination({ destination, protectedHosts: input.protectedHosts }),
  )
  if (allow.some((entry) => entry === undefined)) return undefined
  const destinations = allow.flatMap((entry) => (entry === undefined ? [] : [entry]))
  return {
    phase: input.phase,
    allow: [...new Set(destinations)].sort(),
  }
}

export interface EncryptedEnvironmentValue {
  readonly keyVersion: 1
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authenticationTag: Uint8Array
}

export interface StoredEnvironmentCandidate extends EnvironmentCandidate {
  readonly encrypted: EncryptedEnvironmentValue
}

export interface EnvironmentAuthorityContext {
  readonly ownerId: OwnerId
  readonly projectId?: ProjectId
  readonly userId: BetterAuthUserId
}
