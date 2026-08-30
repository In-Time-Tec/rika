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

const orbPlacement = (row: PlacementRow): WorkspacePlacement => {
  const generation = String(row.generation ?? 0)
  if (row.preparationState === null) {
    if (row.lifecycle !== "provisioning" && row.lifecycle !== "awaiting_bootstrap")
      return { _tag: "OrbWorkspace", state: "unassigned", generation }
    if (row.bootstrapExpiresAt === null || row.bootstrapExpiresAt <= row.databaseNow)
      return {
        _tag: "OrbWorkspace",
        state: "failed",
        generation,
        message: "Workspace provisioning expired before the Executor connected",
      }
    return {
      _tag: "OrbWorkspace",
      state: "preparing",
      generation,
      phase: "setup",
      deadlineAt: row.bootstrapExpiresAt.getTime(),
    }
  }
  if (row.preparationState !== "failed")
    return {
      _tag: "OrbWorkspace",
      state: row.preparationState,
      generation,
      attempt: row.attempt!,
      phase: row.phase!,
      deadlineAt: row.deadlineAt!.getTime(),
    }
  const failure = Option.getOrUndefined(decodePreparationFailure(row.preparationFailure))
  const failed: Extract<WorkspacePlacement, { readonly _tag: "OrbWorkspace" }> = {
    _tag: "OrbWorkspace",
    state: "failed",
    generation,
    message: failure?.message ?? "Workspace preparation failed",
  }
  if (row.attempt !== null) Object.assign(failed, { attempt: row.attempt })
  if (row.phase !== null) Object.assign(failed, { phase: row.phase })
  if (row.deadlineAt !== null) Object.assign(failed, { deadlineAt: row.deadlineAt.getTime() })
  return failed
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
