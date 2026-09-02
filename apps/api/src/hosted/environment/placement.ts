import type { WorkspacePlacement } from "@rika/product/client-protocol"
import type { OwnerId, ThreadId } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorAssignments,
  rikaHostedThreads,
  rikaHostedWorkspacePreparations,
} from "@rika/product-store/database-schema"
import { and, desc, eq, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Option, Schema } from "effect"
import { HostedThreadProtocolError } from "../thread/protocol"

const PreparationFailure = Schema.Struct({ message: Schema.optionalKey(Schema.String) })
const decodePreparationFailure = Schema.decodeUnknownOption(PreparationFailure)

interface PlacementRow {
  readonly executorKind: "runner" | "orb"
  readonly generation: number | null
  readonly lifecycle: string | null
  readonly leaseExpiresAt: Date | null
  readonly bootstrapExpiresAt: Date | null
  readonly latestCheckpointId: string | null
  readonly previousPreparationReady: boolean
  readonly preparationState: "preparing" | "ready" | "failed" | null
  readonly attempt: number | null
  readonly phase: "setup" | "checkout" | "capabilities" | "resume" | null
  readonly deadlineAt: Date | null
  readonly preparationFailure: unknown
  readonly databaseNow: Date
}

const runnerPlacement = (row: PlacementRow): WorkspacePlacement => ({
  _tag: "RunnerWorkspace",
  state:
    row.lifecycle === "active" && row.leaseExpiresAt !== null && row.leaseExpiresAt > row.databaseNow
      ? "ready"
      : "disconnected",
})

export const orbWorkspaceReadiness = (
  row: Pick<
    PlacementRow,
    | "lifecycle"
    | "leaseExpiresAt"
    | "latestCheckpointId"
    | "previousPreparationReady"
    | "preparationState"
    | "databaseNow"
  >,
): "fresh" | "hot" | "cold" => {
  const leaseLive = row.leaseExpiresAt !== null && row.leaseExpiresAt > row.databaseNow
  if (row.lifecycle === "active" && leaseLive && row.preparationState === "ready") return "hot"
  if (row.latestCheckpointId !== null || row.previousPreparationReady || row.preparationState === "ready") return "cold"
  return "fresh"
}

const failedOrbPlacement = (
  row: PlacementRow,
  readiness: "fresh" | "hot" | "cold",
  generation: string,
): WorkspacePlacement => {
  const failure = Option.getOrUndefined(decodePreparationFailure(row.preparationFailure))
  const failed: Extract<WorkspacePlacement, { readonly _tag: "OrbWorkspace" }> = {
    _tag: "OrbWorkspace",
    state: "failed",
    readiness,
    generation,
    message: failure?.message ?? "Workspace preparation failed",
  }
  if (row.attempt !== null) Object.assign(failed, { attempt: row.attempt })
  if (row.phase !== null) Object.assign(failed, { phase: row.phase })
  if (row.deadlineAt !== null) Object.assign(failed, { deadlineAt: row.deadlineAt.getTime() })
  return failed
}

const orbPlacement = (row: PlacementRow): WorkspacePlacement => {
  const generation = String(row.generation ?? 0)
  const readiness = orbWorkspaceReadiness(row)
  const base = { _tag: "OrbWorkspace" as const, readiness, generation }
  if (row.preparationState === "failed") return failedOrbPlacement(row, readiness, generation)
  if (row.lifecycle === "provisioning" || row.lifecycle === "awaiting_bootstrap") {
    if (row.bootstrapExpiresAt === null || row.bootstrapExpiresAt <= row.databaseNow)
      return {
        ...base,
        state: "failed",
        message: "Workspace provisioning expired before the Executor connected",
      }
    if (row.preparationState === "preparing")
      return {
        ...base,
        state: "preparing",
        attempt: row.attempt!,
        phase: row.phase!,
        deadlineAt: row.deadlineAt!.getTime(),
      }
    return {
      ...base,
      state: "preparing",
      phase: readiness === "cold" ? "resume" : "setup",
      deadlineAt: row.bootstrapExpiresAt.getTime(),
    }
  }
  if (
    row.lifecycle === "active" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > row.databaseNow &&
    row.preparationState !== null
  )
    return {
      ...base,
      state: row.preparationState,
      attempt: row.attempt!,
      phase: row.phase!,
      deadlineAt: row.deadlineAt!.getTime(),
    }
  return { ...base, state: "unassigned" }
}

export const workspacePlacement = (db: PgDrizzle.EffectPgDatabase) =>
  Effect.fn("HostedWorkspacePlacement.get")(function* (
    ownerId: OwnerId,
    threadId: ThreadId,
  ): Effect.fn.Return<WorkspacePlacement, HostedThreadProtocolError> {
    const rows = yield* db
      .select({
        executorKind: rikaHostedThreads.executorKind,
        generation: rikaHostedExecutorAssignments.generation,
        lifecycle: rikaHostedExecutorAssignments.lifecycle,
        leaseExpiresAt: rikaHostedExecutorAssignments.leaseExpiresAt,
        bootstrapExpiresAt: rikaHostedExecutorAssignments.bootstrapExpiresAt,
        latestCheckpointId: rikaHostedExecutorAssignments.latestCheckpointId,
        previousPreparationReady: sql<boolean>`exists (
          select 1
          from rika_hosted_workspace_preparations previous_preparation
          where previous_preparation.assignment_id = ${rikaHostedExecutorAssignments.id}
            and previous_preparation.generation < ${rikaHostedExecutorAssignments.generation}
            and previous_preparation.state = 'ready'
        )`,
        preparationState: rikaHostedWorkspacePreparations.state,
        attempt: rikaHostedWorkspacePreparations.attempt,
        phase: rikaHostedWorkspacePreparations.phase,
        deadlineAt: rikaHostedWorkspacePreparations.deadlineAt,
        preparationFailure: rikaHostedWorkspacePreparations.failure,
        databaseNow: sql<Date>`clock_timestamp()`,
      })
      .from(rikaHostedThreads)
      .leftJoin(
        rikaHostedExecutorAssignments,
        and(
          eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id),
          eq(rikaHostedExecutorAssignments.ownerId, rikaHostedThreads.ownerId),
        ),
      )
      .leftJoin(
        rikaHostedWorkspacePreparations,
        and(
          eq(rikaHostedWorkspacePreparations.assignmentId, rikaHostedExecutorAssignments.id),
          eq(rikaHostedWorkspacePreparations.generation, rikaHostedExecutorAssignments.generation),
        ),
      )
      .where(and(eq(rikaHostedThreads.ownerId, ownerId), eq(rikaHostedThreads.id, threadId)))
      .orderBy(desc(rikaHostedExecutorAssignments.generation))
      .limit(1)
      .pipe(
        Effect.mapError(() =>
          HostedThreadProtocolError.make({ kind: "unavailable", message: "Workspace placement is unavailable" }),
        ),
      )
    const row = rows[0]
    if (row === undefined)
      return yield* HostedThreadProtocolError.make({ kind: "not-found", message: "Thread is unavailable" })
    return row.executorKind === "runner" ? runnerPlacement(row) : orbPlacement(row)
  })
