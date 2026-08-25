import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect } from "effect"
import type { WorkspacePlacement } from "@rika/product/client-protocol"
import type { OwnerId, ThreadId } from "@rika/product/hosted-model"
import { HostedThreadProtocolError } from "./hosted-thread-protocol"

export const workspacePlacement = (sql: PgClient.PgClient) =>
  Effect.fn("HostedWorkspacePlacement.get")(function* (
    ownerId: OwnerId,
    threadId: ThreadId,
  ): Effect.fn.Return<WorkspacePlacement, HostedThreadProtocolError> {
    const rows = yield* sql<{
      readonly executorKind: "runner" | "orb"
      readonly generation: string | null
      readonly lifecycle: string | null
      readonly leaseCurrent: boolean | null
      readonly bootstrapLive: boolean | null
      readonly bootstrapDeadlineAt: number | null
      readonly preparationState: "preparing" | "ready" | "failed" | null
      readonly attempt: number | null
      readonly phase: "checkout" | "setup" | "resume" | "capabilities" | null
      readonly deadlineAt: number | null
      readonly message: string | null
    }>`SELECT thread.executor_kind AS "executorKind", assignment.generation::text AS generation,
      assignment.lifecycle, assignment.lease_expires_at > clock_timestamp() AS "leaseCurrent",
      assignment.bootstrap_expires_at > clock_timestamp() AS "bootstrapLive",
      (extract(epoch FROM assignment.bootstrap_expires_at) * 1000)::float8 AS "bootstrapDeadlineAt",
      preparation.state AS "preparationState", preparation.attempt, preparation.phase,
      (extract(epoch FROM preparation.deadline_at) * 1000)::float8 AS "deadlineAt",
      preparation.failure ->> 'message' AS message
      FROM rika_hosted_threads thread
      LEFT JOIN rika_hosted_executor_assignments assignment
        ON assignment.thread_id = thread.id AND assignment.owner_id = thread.owner_id
      LEFT JOIN rika_hosted_workspace_preparations preparation
        ON preparation.assignment_id = assignment.id AND preparation.generation = assignment.generation
      WHERE thread.owner_id = ${ownerId} AND thread.id = ${threadId}
      ORDER BY assignment.generation DESC NULLS LAST LIMIT 1`.pipe(
      Effect.mapError(() =>
        HostedThreadProtocolError.make({ kind: "unavailable", message: "Workspace placement is unavailable" }),
      ),
    )
    const row = rows[0]
    if (row === undefined)
      return yield* HostedThreadProtocolError.make({ kind: "not-found", message: "Thread is unavailable" })
    if (row.executorKind === "runner")
      return {
        _tag: "RunnerWorkspace",
        state: row.lifecycle === "active" && row.leaseCurrent === true ? "ready" : "disconnected",
      }
    const generation = row.generation ?? "0"
    if (row.preparationState === null) {
      if (row.lifecycle !== "provisioning" && row.lifecycle !== "awaiting_bootstrap")
        return { _tag: "OrbWorkspace", state: "unassigned", generation }
      if (row.bootstrapLive !== true || row.bootstrapDeadlineAt === null)
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
        deadlineAt: row.bootstrapDeadlineAt,
      }
    }
    if (row.preparationState === "failed")
      return {
        _tag: "OrbWorkspace",
        state: "failed",
        generation,
        ...(row.attempt === null ? {} : { attempt: row.attempt }),
        ...(row.phase === null ? {} : { phase: row.phase }),
        ...(row.deadlineAt === null ? {} : { deadlineAt: row.deadlineAt }),
        message: row.message ?? "Workspace preparation failed",
      }
    return {
      _tag: "OrbWorkspace",
      state: row.preparationState,
      generation,
      attempt: row.attempt!,
      phase: row.phase!,
      deadlineAt: row.deadlineAt!,
    }
  })
