import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMember } from "@rika/identity"
import {
  EnvironmentReferenceId,
  EnvironmentValueDigest,
  EnvironmentValueName,
  SourceCommitSha,
  resolveEgressPolicy,
  resolveEnvironmentReferences,
  type EnvironmentClassification,
  type EncryptedEnvironmentValue,
  type EnvironmentPhase,
  type EnvironmentReference,
  type EnvironmentScope,
  type PhaseEnvironmentManifest,
  type PhaseEgressPolicy,
  type SourceEnvironmentApproval,
  type SourceTrust,
} from "@rika/product/environment-policy"
import { EnvironmentStore, EnvironmentStoreError } from "@rika/product/environment-store"
import { BetterAuthUserId, OwnerId, ProjectId, type HostedOwner } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedThreads,
} from "@rika/product-store/database-schema"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Context, Crypto, Effect, Encoding, Layer, Option, Redacted, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"
import * as SecretCipher from "../../security/secret-cipher"

export class HostedEnvironmentError extends Schema.TaggedError<HostedEnvironmentError>()("HostedEnvironmentError", {
  kind: Schema.Literals(["forbidden", "invalid", "missing", "unavailable"]),
  message: Schema.String,
}) {}

export interface ResolvedPhaseEnvironment {
  readonly manifest: PhaseEnvironmentManifest
  readonly values: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly egress: PhaseEgressPolicy
}

interface OwnerInput {
  readonly principal: AuthenticatedPrincipal
  readonly owner: HostedOwner
  readonly projectId?: string
}

interface ResolvedOwner {
  readonly ownerId: OwnerId
  readonly kind: "personal" | "organization"
  readonly projectId?: ProjectId
  readonly userId: BetterAuthUserId
}

export interface HostedEnvironmentService {
  readonly put: (
    input: OwnerInput & {
      readonly scope: EnvironmentScope
      readonly name: string
      readonly classification: EnvironmentClassification
      readonly phases: ReadonlyArray<EnvironmentPhase>
      readonly value: Redacted.Redacted<string>
    },
  ) => Effect.Effect<EnvironmentReference, HostedEnvironmentError>
  readonly revoke: (
    input: OwnerInput & { readonly scope: EnvironmentScope; readonly name: string },
  ) => Effect.Effect<EnvironmentReference, HostedEnvironmentError>
  readonly putOrganizationPolicy: (
    input: OwnerInput & { readonly personalOverrides: boolean },
  ) => Effect.Effect<void, HostedEnvironmentError>
  readonly approveSource: (
    input: OwnerInput & {
      readonly sourceOwner: string
      readonly sourceCommitSha: string
      readonly phase: EnvironmentPhase
    },
  ) => Effect.Effect<SourceEnvironmentApproval, HostedEnvironmentError>
  readonly revokeSourceApproval: (
    input: OwnerInput & {
      readonly sourceOwner: string
      readonly sourceCommitSha: string
      readonly phase: EnvironmentPhase
    },
  ) => Effect.Effect<SourceEnvironmentApproval, HostedEnvironmentError>
  readonly putEgress: (
    input: OwnerInput & { readonly phase: EnvironmentPhase; readonly allow: ReadonlyArray<string> },
  ) => Effect.Effect<PhaseEgressPolicy, HostedEnvironmentError>
  readonly usePhase: <A, E, R>(
    input: {
      readonly assignmentId: string
      readonly phase: EnvironmentPhase
    },
    use: (environment: ResolvedPhaseEnvironment) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, HostedEnvironmentError | E, R>
}

export class HostedEnvironment extends Context.Service<HostedEnvironment, HostedEnvironmentService>()(
  "@rika/api/hosted/environment/runtime/HostedEnvironment",
) {}

const rejected = (kind: HostedEnvironmentError["kind"], message: string) =>
  HostedEnvironmentError.make({ kind, message })
const unavailable = () => rejected("unavailable", "Hosted environment service is unavailable")
const PhaseEnvironmentDigest = Schema.Array(
  Schema.Struct({
    id: EnvironmentReferenceId,
    name: EnvironmentValueName,
    revision: Schema.String,
    valueDigest: EnvironmentValueDigest,
  }),
)
const encodePhaseEnvironmentDigest = Schema.encodeSync(Schema.fromJsonString(PhaseEnvironmentDigest))
const Checkout = Schema.Struct({
  owner: Schema.optionalKey(Schema.String),
  commitSha: Schema.optionalKey(Schema.String),
})
const decodeCheckout = Schema.decodeUnknownOption(Checkout)
const storeFailure = (error: EnvironmentStoreError) => {
  if (error.kind === "not-found") return rejected("missing", error.message)
  if (error.kind === "forbidden") return rejected("forbidden", "Environment operation was rejected")
  if (error.kind === "invalid" || error.kind === "conflict") return rejected("invalid", error.message)
  return unavailable()
}

export const layer = (options: {
  readonly encryptionKey: Redacted.Redacted<string>
  readonly protectedEgressHosts: ReadonlySet<string>
}) =>
  Layer.effect(
    HostedEnvironment,
    Effect.gen(function* () {
      yield* PgClient.PgClient
      const db = yield* PgDrizzle.makeWithDefaults()
      const crypto = yield* Crypto.Crypto
      const store = yield* EnvironmentStore
      const cipher = SecretCipher.makeSecretCipher({ encodedKey: options.encryptionKey, domain: "environment" })

      const authority = Effect.fn("HostedEnvironment.authority")(function* (input: OwnerInput) {
        if (input.owner._tag === "PersonalOwner" && input.owner.userId !== input.principal.userId)
          return yield* rejected("forbidden", "Owner is unavailable")
        const rows = yield* db
          .select({ ownerId: rikaHostedOwners.id, projectId: rikaHostedProjects.id })
          .from(rikaHostedOwners)
          .leftJoin(
            identityMember,
            and(
              eq(identityMember.organizationId, rikaHostedOwners.organizationId),
              eq(identityMember.userId, input.principal.userId),
              inArray(identityMember.role, ["owner", "admin"]),
            ),
          )
          .leftJoin(
            rikaHostedProjects,
            and(eq(rikaHostedProjects.ownerId, rikaHostedOwners.id), eq(rikaHostedProjects.id, input.projectId ?? "")),
          )
          .where(
            and(
              input.owner._tag === "PersonalOwner"
                ? and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, input.principal.userId))
                : and(
                    eq(rikaHostedOwners.kind, "organization"),
                    eq(rikaHostedOwners.organizationId, input.owner.organizationId),
                    isNotNull(identityMember.id),
                  ),
              input.projectId === undefined ? undefined : isNotNull(rikaHostedProjects.id),
            ),
          )
          .pipe(Effect.mapError(unavailable))
        const row = rows[0]
        if (row === undefined) return yield* rejected("forbidden", "Owner or Project is unavailable")
        const common: ResolvedOwner = {
          ownerId: OwnerId.make(row.ownerId),
          kind: input.owner._tag === "PersonalOwner" ? "personal" : "organization",
          userId: BetterAuthUserId.make(input.principal.userId),
        }
        return row.projectId === null ? common : { ...common, projectId: ProjectId.make(row.projectId) }
      })

      const scoped = Effect.fn("HostedEnvironment.scoped")(function* (
        input: OwnerInput & { readonly scope: EnvironmentScope },
      ) {
        const resolved = yield* authority(input)
        if (input.scope === "organization" && resolved.kind !== "organization")
          return yield* rejected("invalid", "Organization environment requires an organization owner")
        if (input.scope === "project" && resolved.projectId === undefined)
          return yield* rejected("invalid", "Project environment requires a Project")
        let scopeId = String(resolved.projectId)
        if (input.scope === "personal") scopeId = String(resolved.userId)
        if (input.scope === "organization") scopeId = String(resolved.ownerId)
        return {
          ...resolved,
          scopeId,
        }
      })

      const digest = Effect.fn("HostedEnvironment.digest")(function* (value: EncryptedEnvironmentValue) {
        const material = new Uint8Array(
          value.nonce.byteLength + value.ciphertext.byteLength + value.authenticationTag.byteLength,
        )
        material.set(value.nonce)
        material.set(value.ciphertext, value.nonce.byteLength)
        material.set(value.authenticationTag, value.nonce.byteLength + value.ciphertext.byteLength)
        const bytes = yield* crypto.digest("SHA-256", material).pipe(Effect.mapError(unavailable))
        return EnvironmentValueDigest.make(`sha256:${Encoding.encodeHex(bytes)}`)
      })

      const put: HostedEnvironmentService["put"] = Effect.fn("HostedEnvironment.put")(function* (input) {
        const value = Redacted.value(input.value)
        if (value.length === 0) return yield* rejected("invalid", "Environment value must not be empty")
        const name = yield* Schema.decodeEffect(EnvironmentValueName)(input.name).pipe(
          Effect.mapError(() => rejected("invalid", "Environment name is invalid")),
        )
        const resolved = yield* scoped(input)
        const identity = `${resolved.ownerId}/${input.scope}/${resolved.scopeId}/${name}`
        const encrypted = cipher.encrypt(identity, input.value)
        const request = {
          id: EnvironmentReferenceId.make(
            `environment-${yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable))}`,
          ),
          ownerId: resolved.ownerId,
          userId: resolved.userId,
          scope: input.scope,
          scopeId: resolved.scopeId,
          name,
          classification: input.classification,
          phases: input.phases,
          valueDigest: yield* digest(encrypted),
          encrypted,
          actorUserId: resolved.userId,
        }
        return yield* store
          .putValue(
            input.scope === "project" && resolved.projectId !== undefined
              ? { ...request, projectId: resolved.projectId }
              : request,
          )
          .pipe(Effect.mapError(storeFailure))
      })

      const revoke: HostedEnvironmentService["revoke"] = Effect.fn("HostedEnvironment.revoke")(function* (input) {
        const name = yield* Schema.decodeEffect(EnvironmentValueName)(input.name).pipe(
          Effect.mapError(() => rejected("invalid", "Environment name is invalid")),
        )
        const resolved = yield* scoped(input)
        const request = {
          ownerId: resolved.ownerId,
          userId: resolved.userId,
          scope: input.scope,
          scopeId: resolved.scopeId,
          name,
          actorUserId: resolved.userId,
        }
        return yield* store
          .revokeValue(
            input.scope === "project" && resolved.projectId !== undefined
              ? { ...request, projectId: resolved.projectId }
              : request,
          )
          .pipe(Effect.mapError(storeFailure))
      })

      const putOrganizationPolicy: HostedEnvironmentService["putOrganizationPolicy"] = Effect.fn(
        "HostedEnvironment.putOrganizationPolicy",
      )(function* (input) {
        const resolved = yield* authority(input)
        if (resolved.kind !== "organization")
          return yield* rejected("invalid", "Environment override policy requires an organization owner")
        yield* store
          .putOrganizationPolicy({
            ownerId: resolved.ownerId,
            personalOverrides: input.personalOverrides,
            actorUserId: resolved.userId,
          })
          .pipe(Effect.mapError(storeFailure))
      })

      const approvalInput = Effect.fn("HostedEnvironment.approvalInput")(function* (
        input: OwnerInput & {
          readonly sourceOwner: string
          readonly sourceCommitSha: string
          readonly phase: EnvironmentPhase
        },
      ) {
        const resolved = yield* authority(input)
        const sourceCommitSha = yield* Schema.decodeEffect(SourceCommitSha)(input.sourceCommitSha).pipe(
          Effect.mapError(() => rejected("invalid", "Source commit SHA is invalid")),
        )
        if (input.sourceOwner.trim().length === 0) return yield* rejected("invalid", "Source owner is required")
        const request = {
          ownerId: resolved.ownerId,
          sourceOwner: input.sourceOwner,
          sourceCommitSha,
          phase: input.phase,
          actorUserId: resolved.userId,
        }
        return resolved.projectId === undefined ? request : { ...request, projectId: resolved.projectId }
      })

      const approveSource: HostedEnvironmentService["approveSource"] = Effect.fn("HostedEnvironment.approveSource")(
        function* (input) {
          return yield* store.putApproval(yield* approvalInput(input)).pipe(Effect.mapError(storeFailure))
        },
      )
      const revokeSourceApproval: HostedEnvironmentService["revokeSourceApproval"] = Effect.fn(
        "HostedEnvironment.revokeSourceApproval",
      )(function* (input) {
        return yield* store.revokeApproval(yield* approvalInput(input)).pipe(Effect.mapError(storeFailure))
      })

      const putEgress: HostedEnvironmentService["putEgress"] = Effect.fn("HostedEnvironment.putEgress")(
        function* (input) {
          const resolved = yield* authority(input)
          const policy = resolveEgressPolicy({
            phase: input.phase,
            approved: input.allow,
            protectedHosts: options.protectedEgressHosts,
          })
          if (policy === undefined)
            return yield* rejected("invalid", "Egress allowlist contains a protected destination")
          const request = {
            ownerId: resolved.ownerId,
            policy,
            actorUserId: resolved.userId,
          }
          return yield* store
            .putEgress(resolved.projectId === undefined ? request : { ...request, projectId: resolved.projectId })
            .pipe(Effect.mapError(storeFailure))
        },
      )

      const usePhase: HostedEnvironmentService["usePhase"] = Effect.fn("HostedEnvironment.usePhase")(
        function* (input, use) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const assignments = yield* tx
                  .select({
                    ownerId: rikaHostedExecutorAssignments.ownerId,
                    projectId: rikaHostedThreads.projectId,
                    userId: rikaHostedThreads.createdByUserId,
                    checkout: rikaHostedExecutorAssignments.checkout,
                  })
                  .from(rikaHostedExecutorAssignments)
                  .innerJoin(
                    rikaHostedThreads,
                    and(
                      eq(rikaHostedThreads.id, rikaHostedExecutorAssignments.threadId),
                      eq(rikaHostedThreads.ownerId, rikaHostedExecutorAssignments.ownerId),
                    ),
                  )
                  .where(eq(rikaHostedExecutorAssignments.id, input.assignmentId))
                  .for("share", { of: [rikaHostedExecutorAssignments, rikaHostedThreads] })
                  .pipe(Effect.mapError(unavailable))
                const assignment = assignments[0]
                if (assignment === undefined) return yield* rejected("missing", "Executor assignment is unavailable")
                const checkout = Option.getOrUndefined(decodeCheckout(assignment.checkout))
                const durableOwner = checkout?.owner
                const durableSha = checkout?.commitSha
                const sourceBound = durableOwner !== undefined && durableSha !== undefined
                const source: SourceTrust = sourceBound
                  ? {
                      owner: durableOwner,
                      commitSha: SourceCommitSha.make(durableSha),
                      fork: true,
                      trustedRef: false,
                    }
                  : {
                      owner: "unbound-source",
                      commitSha: SourceCommitSha.make("0".repeat(40)),
                      fork: true,
                      trustedRef: false,
                    }
                const phaseRequest = {
                  ownerId: OwnerId.make(assignment.ownerId),
                  userId: BetterAuthUserId.make(assignment.userId),
                  phase: input.phase,
                  source,
                }
                const storedPhase = yield* store
                  .resolvePhase(
                    assignment.projectId === null
                      ? phaseRequest
                      : { ...phaseRequest, projectId: ProjectId.make(assignment.projectId) },
                  )
                  .pipe(Effect.mapError(storeFailure))
                const resolution = {
                  candidates: storedPhase.candidates,
                  phase: input.phase,
                  source,
                  organizationPersonalOverrides: storedPhase.organizationPersonalOverrides,
                }
                const references = resolveEnvironmentReferences(
                  sourceBound && storedPhase.approval !== undefined
                    ? { ...resolution, approval: storedPhase.approval }
                    : resolution,
                )
                const byId = new Map(storedPhase.candidates.map((candidate) => [candidate.reference.id, candidate]))
                const values: Record<string, Redacted.Redacted<string>> = {}
                for (const reference of references) {
                  const candidate = byId.get(reference.id)
                  if (candidate === undefined) return yield* unavailable()
                  const identity = `${reference.ownerId}/${reference.scope}/${reference.scopeId}/${reference.name}`
                  values[reference.name] = yield* Effect.try({
                    try: () => cipher.decrypt(identity, candidate.encrypted),
                    catch: unavailable,
                  })
                }
                const encoded = encodePhaseEnvironmentDigest(references)
                const digestBytes = yield* crypto
                  .digest("SHA-256", new TextEncoder().encode(`${input.phase}\n${encoded}`))
                  .pipe(Effect.mapError(unavailable))
                const egress = resolveEgressPolicy({
                  phase: input.phase,
                  approved: storedPhase.egress.allow,
                  protectedHosts: options.protectedEgressHosts,
                })
                if (egress === undefined)
                  return yield* rejected("invalid", "Stored egress policy contains a protected destination")
                return yield* use({
                  manifest: {
                    phase: input.phase,
                    digest: EnvironmentValueDigest.make(`sha256:${Encoding.encodeHex(digestBytes)}`),
                    references,
                  },
                  values,
                  egress,
                })
              }),
            )
            .pipe(Effect.catchTag("SqlError", unavailable))
        },
      )

      return HostedEnvironment.of({
        put,
        revoke,
        putOrganizationPolicy,
        approveSource,
        revokeSourceApproval,
        putEgress,
        usePhase,
      })
    }),
  )
