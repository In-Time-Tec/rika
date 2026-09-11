import * as PgClient from "@effect/sql-pg/PgClient"
import {
  OrbPlacement,
  RepositoryCheckout,
  WorkspaceSeed,
  type RepositoryCheckout as RepositoryCheckoutValue,
  type WorkspaceSeed as WorkspaceSeedValue,
} from "@rika/product/executor-assignment"
import { ExecutorPolicy } from "@rika/product/executor-policy"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Option, Schema } from "effect"
import { rikaBoxAssignmentBindings } from "../../database/schema/box/assignments"
import { rikaHostedExecutorAssignments } from "../../database/schema/product"
import {
  BoxAssignmentGeneration,
  BoxAssignmentIdentity,
  decodeBoxAssignmentIdentity,
  encodeBoxAssignmentIdentity,
} from "./box-assignment-identity"

const Identifier = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,255}$/))
const BoxId = Schema.String.check(Schema.isPattern(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/))
const OrbExecutorPlacementPolicySchema = Schema.Struct({
  ...OrbPlacement.fields,
  executorPolicy: ExecutorPolicy,
  lineageId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
})

export const BoxAssignmentLifecycle = Schema.Literals([
  "pending",
  "provisioning",
  "awaiting_bootstrap",
  "active",
  "paused",
  "terminated",
])
export type BoxAssignmentLifecycle = typeof BoxAssignmentLifecycle.Type
export type OrbExecutorPlacementPolicy = typeof OrbExecutorPlacementPolicySchema.Type

export const BoxAssignmentFailureReason = Schema.Literals([
  "invalid",
  "not-found",
  "stale-fence",
  "conflict",
  "invalid-state",
  "database",
])
export type BoxAssignmentFailureReason = typeof BoxAssignmentFailureReason.Type

export class BoxAssignmentError extends Schema.TaggedError<BoxAssignmentError>()("BoxAssignmentError", {
  reason: BoxAssignmentFailureReason,
  message: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
}) {}

export const BoxAssignmentProjection = Schema.Struct({
  assignmentId: BoxAssignmentIdentity,
  ownerId: Identifier,
  threadId: Identifier,
  workspaceId: Identifier,
  generation: BoxAssignmentGeneration,
  placement: OrbExecutorPlacementPolicySchema,
  providerInstanceId: Schema.NullOr(BoxId),
  lifecycle: BoxAssignmentLifecycle,
  checkout: Schema.NullOr(RepositoryCheckout),
  workspaceSeed: Schema.NullOr(WorkspaceSeed),
})
export type BoxAssignmentProjection = typeof BoxAssignmentProjection.Type

export interface BindBoxAssignmentInput {
  readonly assignmentId: string
  readonly generation: number
  readonly workspaceId: string
  readonly placement: OrbExecutorPlacementPolicy
  readonly boxId: string
}

export interface BoxAssignmentRepository {
  readonly get: (assignmentId: string) => Effect.Effect<BoxAssignmentProjection | undefined, BoxAssignmentError>
  readonly bind: (input: BindBoxAssignmentInput) => Effect.Effect<BoxAssignmentProjection, BoxAssignmentError>
  readonly rotate: (expected: BoxAssignmentProjection) => Effect.Effect<BoxAssignmentProjection, BoxAssignmentError>
}

const assignmentFields = {
  rawAssignmentId: rikaHostedExecutorAssignments.id,
  ownerId: rikaHostedExecutorAssignments.ownerId,
  threadId: rikaHostedExecutorAssignments.threadId,
  workspaceId: rikaHostedExecutorAssignments.workspaceId,
  executorKind: rikaHostedExecutorAssignments.executorKind,
  generation: rikaHostedExecutorAssignments.generation,
  revision: rikaHostedExecutorAssignments.revision,
  placement: rikaHostedExecutorAssignments.placement,
  lifecycle: rikaHostedExecutorAssignments.lifecycle,
  checkout: rikaHostedExecutorAssignments.checkout,
  workspaceSeed: rikaHostedExecutorAssignments.workspaceSeed,
}

const rowFields = {
  ...assignmentFields,
  providerInstanceId: rikaBoxAssignmentBindings.boxId,
}

const AssignmentRow = Schema.Struct({
  rawAssignmentId: Identifier,
  ownerId: Identifier,
  threadId: Identifier,
  workspaceId: Identifier,
  executorKind: Schema.Literals(["runner", "orb"]),
  generation: BoxAssignmentGeneration,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  placement: Schema.Unknown,
  providerInstanceId: Schema.NullOr(BoxId),
  lifecycle: BoxAssignmentLifecycle,
  checkout: Schema.Unknown,
  workspaceSeed: Schema.Unknown,
})
type SelectedRow = {
  readonly rawAssignmentId: string
  readonly ownerId: string
  readonly threadId: string
  readonly workspaceId: string
  readonly executorKind: "runner" | "orb"
  readonly generation: number
  readonly revision: number
  readonly placement: unknown
  readonly providerInstanceId: string | null
  readonly lifecycle: BoxAssignmentLifecycle
  readonly checkout: unknown
  readonly workspaceSeed: unknown
}

const failure = (reason: BoxAssignmentFailureReason, message: string) => BoxAssignmentError.make({ reason, message })
const invalid = () => failure("invalid", "Box assignment input is invalid")
const databaseError = (cause: unknown) =>
  Schema.is(BoxAssignmentError)(cause) ? cause : failure("database", "Box assignment storage is unavailable")
const query = <A extends object>(statement: Effect.Effect<ReadonlyArray<A>, EffectDrizzleQueryError>) =>
  statement.pipe(Effect.mapError(databaseError))

const decodeProjection = Effect.fn("BoxAssignments.decodeProjection")(function* (value: SelectedRow) {
  const row = yield* Schema.decodeEffect(AssignmentRow)(value).pipe(Effect.mapError(invalid))
  if (row.executorKind !== "orb") return yield* invalid()
  const placement = yield* Schema.decodeUnknownEffect(OrbExecutorPlacementPolicySchema)(row.placement).pipe(
    Effect.mapError(invalid),
  )
  const assignmentId = Option.getOrUndefined(
    encodeBoxAssignmentIdentity({ rawAssignmentId: row.rawAssignmentId, generation: row.generation }),
  )
  if (assignmentId === undefined) return yield* invalid()
  const checkout = yield* Schema.decodeUnknownEffect(Schema.NullOr(RepositoryCheckout))(row.checkout).pipe(
    Effect.mapError(invalid),
  )
  const workspaceSeed = yield* Schema.decodeUnknownEffect(Schema.NullOr(WorkspaceSeed))(row.workspaceSeed).pipe(
    Effect.mapError(invalid),
  )
  return {
    assignmentId,
    ownerId: row.ownerId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    generation: row.generation,
    placement,
    providerInstanceId: row.providerInstanceId,
    lifecycle: row.lifecycle,
    checkout,
    workspaceSeed,
  } satisfies BoxAssignmentProjection
})

const samePlacement = (left: OrbExecutorPlacementPolicy, right: OrbExecutorPlacementPolicy) =>
  left._tag === right._tag &&
  left.lineageId === right.lineageId &&
  left.templateBuildId === right.templateBuildId &&
  left.providerScope === right.providerScope &&
  left.executorPolicy.buildId === right.executorPolicy.buildId &&
  left.executorPolicy.protocolVersion === right.executorPolicy.protocolVersion

const sameCheckout = (left: RepositoryCheckoutValue | null, right: RepositoryCheckoutValue | null) =>
  left === null
    ? right === null
    : right !== null &&
      left.ownerId === right.ownerId &&
      left.projectId === right.projectId &&
      left.repositoryId === right.repositoryId &&
      left.installationId === right.installationId &&
      left.owner === right.owner &&
      left.name === right.name &&
      left.ref === right.ref &&
      left.commitSha === right.commitSha &&
      left.private === right.private &&
      left.gitIdentity.name === right.gitIdentity.name &&
      left.gitIdentity.email === right.gitIdentity.email

const sameWorkspaceSeed = (left: WorkspaceSeedValue | null, right: WorkspaceSeedValue | null) =>
  left === null
    ? right === null
    : right !== null &&
      left.id === right.id &&
      (left.sourceRepository === null
        ? right.sourceRepository === null
        : right.sourceRepository !== null &&
          left.sourceRepository.owner === right.sourceRepository.owner &&
          left.sourceRepository.name === right.sourceRepository.name) &&
      left.objectKey === right.objectKey &&
      left.contentDigest === right.contentDigest &&
      left.sizeBytes === right.sizeBytes &&
      left.archiveDigest === right.archiveDigest &&
      left.archiveSizeBytes === right.archiveSizeBytes &&
      left.encryption === right.encryption

const sameRotationMetadata = (current: BoxAssignmentProjection, expected: BoxAssignmentProjection) =>
  [
    current.ownerId === expected.ownerId,
    current.threadId === expected.threadId,
    current.workspaceId === expected.workspaceId,
    current.lifecycle === expected.lifecycle,
    samePlacement(current.placement, expected.placement),
    sameCheckout(current.checkout, expected.checkout),
    sameWorkspaceSeed(current.workspaceSeed, expected.workspaceSeed),
  ].every(Boolean)

const sameRotationBinding = (
  current: BoxAssignmentProjection,
  providerInstanceId: string,
  expectedBoxId: string | undefined,
) => [expectedBoxId === providerInstanceId, current.providerInstanceId === providerInstanceId].every(Boolean)

const rotationBoxId = (expected: BoxAssignmentProjection) => expected.providerInstanceId ?? ""

const decodeBindInput = Effect.fn("BoxAssignments.decodeBindInput")(function* (input: BindBoxAssignmentInput) {
  const values = yield* Schema.decodeEffect(
    Schema.Struct({
      assignmentId: BoxAssignmentIdentity,
      generation: BoxAssignmentGeneration,
      workspaceId: Identifier,
      placement: OrbExecutorPlacementPolicySchema,
      boxId: BoxId,
    }),
  )(input).pipe(Effect.mapError(invalid))
  const fence = Option.getOrUndefined(decodeBoxAssignmentIdentity(values.assignmentId))
  if (fence === undefined) return yield* invalid()
  if (fence.generation !== values.generation) return yield* failure("stale-fence", "Box assignment fence is stale")
  return { ...values, placement: values.placement, rawAssignmentId: fence.rawAssignmentId }
})

const decodeRotateInput = Effect.fn("BoxAssignments.decodeRotateInput")(function* (input: BoxAssignmentProjection) {
  const expected = yield* Schema.decodeEffect(BoxAssignmentProjection)(input).pipe(Effect.mapError(invalid))
  const fence = Option.getOrUndefined(decodeBoxAssignmentIdentity(expected.assignmentId))
  if (fence === undefined) return yield* invalid()
  if (fence.generation !== expected.generation) return yield* failure("stale-fence", "Box assignment fence is stale")
  return { ...expected, placement: expected.placement, rawAssignmentId: fence.rawAssignmentId }
})

export const makeBoxAssignmentRepository = Effect.gen(function* (): Effect.fn.Return<
  BoxAssignmentRepository,
  never,
  PgClient.PgClient
> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const selectAssignment = (executor: PgDrizzle.EffectPgDatabase, rawAssignmentId: string) =>
    query(
      executor
        .select(assignmentFields)
        .from(rikaHostedExecutorAssignments)
        .where(eq(rikaHostedExecutorAssignments.id, rawAssignmentId))
        .for("update"),
    )

  const selectProjection = (executor: PgDrizzle.EffectPgDatabase, rawAssignmentId: string) =>
    query(
      executor
        .select(rowFields)
        .from(rikaHostedExecutorAssignments)
        .leftJoin(
          rikaBoxAssignmentBindings,
          and(
            eq(rikaBoxAssignmentBindings.assignmentId, rikaHostedExecutorAssignments.id),
            eq(rikaBoxAssignmentBindings.generation, rikaHostedExecutorAssignments.generation),
          ),
        )
        .where(
          and(
            eq(rikaHostedExecutorAssignments.id, rawAssignmentId),
            eq(rikaHostedExecutorAssignments.executorKind, "orb"),
          ),
        ),
    )

  const selectBindings = (
    executor: PgDrizzle.EffectPgDatabase,
    rawAssignmentId: string,
    generations: ReadonlyArray<number>,
  ) =>
    query(
      executor
        .select({ generation: rikaBoxAssignmentBindings.generation, boxId: rikaBoxAssignmentBindings.boxId })
        .from(rikaBoxAssignmentBindings)
        .where(
          and(
            eq(rikaBoxAssignmentBindings.assignmentId, rawAssignmentId),
            inArray(rikaBoxAssignmentBindings.generation, [...generations]),
          ),
        ),
    )

  const get: BoxAssignmentRepository["get"] = Effect.fn("BoxAssignments.get")(function* (assignmentId) {
    const fence = Option.getOrUndefined(decodeBoxAssignmentIdentity(assignmentId))
    if (fence === undefined) return yield* invalid()
    const row = (yield* selectProjection(db, fence.rawAssignmentId))[0]
    if (row === undefined) return undefined
    if (row.generation !== fence.generation) return yield* failure("stale-fence", "Box assignment fence is stale")
    const projection = yield* decodeProjection(row)
    if (projection.assignmentId !== assignmentId) return yield* invalid()
    return projection
  })

  const bind: BoxAssignmentRepository["bind"] = Effect.fn("BoxAssignments.bind")(function* (input) {
    const expected = yield* decodeBindInput(input)
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const selected = (yield* selectAssignment(tx, expected.rawAssignmentId))[0]
          if (selected?.executorKind !== "orb") return yield* failure("not-found", "Box assignment is unavailable")
          const existing = (yield* query(
            tx
              .select({ boxId: rikaBoxAssignmentBindings.boxId })
              .from(rikaBoxAssignmentBindings)
              .where(
                and(
                  eq(rikaBoxAssignmentBindings.assignmentId, expected.rawAssignmentId),
                  eq(rikaBoxAssignmentBindings.generation, selected.generation),
                ),
              ),
          ))[0]
          const current = yield* decodeProjection({ ...selected, providerInstanceId: existing?.boxId ?? null })
          if (
            current.assignmentId !== expected.assignmentId ||
            current.generation !== expected.generation ||
            current.workspaceId !== expected.workspaceId ||
            !samePlacement(current.placement, expected.placement)
          )
            return yield* failure("stale-fence", "Box assignment fence is stale")
          if (current.lifecycle === "paused" || current.lifecycle === "terminated")
            return yield* failure("invalid-state", "Box assignment cannot be bound in its current state")
          if (current.providerInstanceId !== null) {
            if (current.providerInstanceId === expected.boxId) return current
            return yield* failure("conflict", "Box assignment is already bound")
          }
          const inserted = yield* query(
            tx
              .insert(rikaBoxAssignmentBindings)
              .values({
                assignmentId: expected.rawAssignmentId,
                generation: expected.generation,
                boxId: expected.boxId,
              })
              .returning({ boxId: rikaBoxAssignmentBindings.boxId }),
          )
          if (inserted[0] === undefined) return yield* failure("conflict", "Box assignment changed concurrently")
          return { ...current, providerInstanceId: inserted[0].boxId }
        }),
      )
      .pipe(Effect.mapError(databaseError))
  })

  const rotate: BoxAssignmentRepository["rotate"] = Effect.fn("BoxAssignments.rotate")(function* (input) {
    const expected = yield* decodeRotateInput(input)
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const selected = (yield* selectAssignment(tx, expected.rawAssignmentId))[0]
          if (selected?.executorKind !== "orb") return yield* failure("not-found", "Box assignment is unavailable")
          if (![expected.generation, expected.generation + 1].includes(selected.generation))
            return yield* failure("stale-fence", "Box assignment fence is stale")

          const bindings = yield* selectBindings(tx, expected.rawAssignmentId, [
            expected.generation,
            selected.generation,
          ])
          const expectedBinding = bindings.find((binding) => binding.generation === expected.generation)
          const currentBinding = bindings.find((binding) => binding.generation === selected.generation)
          const current = yield* decodeProjection({
            ...selected,
            providerInstanceId: currentBinding?.boxId ?? null,
          })

          if (!sameRotationMetadata(current, expected))
            return yield* failure("stale-fence", "Box assignment fence is stale")
          if (["paused", "terminated"].includes(current.lifecycle))
            return yield* failure("invalid-state", "Box assignment cannot be rotated in its current state")
          const boxId = rotationBoxId(expected)
          if (!sameRotationBinding(current, boxId, expectedBinding?.boxId))
            return yield* failure("conflict", "Box assignment binding changed")

          if (selected.generation === expected.generation + 1) return current
          if (current.assignmentId !== expected.assignmentId)
            return yield* failure("stale-fence", "Box assignment fence is stale")
          if ([selected.generation, selected.revision].includes(Number.MAX_SAFE_INTEGER))
            return yield* failure("invalid-state", "Box assignment fence cannot be rotated")

          const nextGeneration = selected.generation + 1
          const updated = (yield* query(
            tx
              .update(rikaHostedExecutorAssignments)
              .set({
                generation: nextGeneration,
                revision: sql`${rikaHostedExecutorAssignments.revision} + 1`,
                updatedAt: sql`transaction_timestamp()`,
              })
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, expected.rawAssignmentId),
                  eq(rikaHostedExecutorAssignments.generation, expected.generation),
                ),
              )
              .returning(assignmentFields),
          ))[0]
          if (updated === undefined) return yield* failure("conflict", "Box assignment changed concurrently")
          const inserted = yield* query(
            tx
              .insert(rikaBoxAssignmentBindings)
              .values({
                assignmentId: expected.rawAssignmentId,
                generation: nextGeneration,
                boxId,
              })
              .onConflictDoNothing()
              .returning({ boxId: rikaBoxAssignmentBindings.boxId }),
          )
          if (inserted[0] === undefined) return yield* failure("conflict", "Box assignment changed concurrently")
          return yield* decodeProjection({ ...updated, providerInstanceId: inserted[0].boxId })
        }),
      )
      .pipe(Effect.mapError(databaseError))
  })

  return { get, bind, rotate }
})
