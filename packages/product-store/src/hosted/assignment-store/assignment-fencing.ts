import { Effect } from "effect"
import { sql as expression } from "drizzle-orm"
import type { AssignmentsService } from "@rika/product/executor-assignments"
import { decodeAssignment } from "./assignment-row"
import { rikaHostedExecutorAssignments } from "../../database/schema/product"
import type { AssignmentOperations } from "./assignment-operations"

export const fencingOperations = (operations: AssignmentOperations) => {
  const { checkAccess, checkFence, failure, locked, transaction, updated, updateFence } = operations

  const updateCapabilities: AssignmentsService["updateCapabilities"] = Effect.fn("Assignments.updateCapabilities")(
    function* (input) {
      return yield* transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.access.assignmentId, "update")
          yield* checkAccess(row, input.access, true)
          return yield* updated(
            tx,
            input.access.assignmentId,
            updateFence(tx, input.access, {
              revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
              capabilityGeneration: expression`${rikaHostedExecutorAssignments.generation}`,
              capabilitySnapshot: input.capabilities,
              lastActiveAt: expression`transaction_timestamp()`,
              updatedAt: expression`transaction_timestamp()`,
            }),
          )
        }),
      )
    },
  )

  const reconnect: AssignmentsService["reconnect"] = Effect.fn("Assignments.reconnect")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.access.assignmentId, "update")
        yield* checkAccess(row, input.access, false)
        return yield* updated(
          tx,
          input.access.assignmentId,
          updateFence(tx, input.access, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lastLeaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
            leaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
            leaseExpiresAt: expression`transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond')`,
            lastActiveAt: expression`transaction_timestamp()`,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  const heartbeat: AssignmentsService["heartbeat"] = Effect.fn("Assignments.heartbeat")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.access.assignmentId, "update")
        yield* checkAccess(row, input.access, true)
        if (BigInt(input.cursor.sequence) < BigInt(row.cursorSequence))
          return yield* failure("conflict", "Executor cursor cannot move backwards")
        if (input.cursor.sequence === row.cursorSequence && input.cursor.value !== row.cursorValue)
          return yield* failure("conflict", "Executor cursor conflicts at the same sequence")
        return yield* updated(
          tx,
          input.access.assignmentId,
          updateFence(tx, input.access, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            cursorSequence: Number(input.cursor.sequence),
            cursorValue: input.cursor.value,
            leaseExpiresAt: expression`transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond')`,
            lastActiveAt: expression`transaction_timestamp()`,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  const authenticate: AssignmentsService["authenticate"] = Effect.fn("Assignments.authenticate")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "share")
        yield* checkAccess(row, input, true)
        return yield* decodeAssignment(row)
      }),
    )
  })

  const release: AssignmentsService["release"] = Effect.fn("Assignments.release")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkAccess(row, input, false)
        return yield* updated(
          tx,
          input.assignmentId,
          updateFence(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lifecycle: "paused",
            bootstrapDigest: null,
            bootstrapExpiresAt: null,
            executorInstanceId: null,
            processIncarnation: null,
            sessionDigest: null,
            leaseEpoch: null,
            leaseExpiresAt: null,
            updatedAt: expression`clock_timestamp()`,
          }),
        )
      }),
    )
  })

  const validateFence: AssignmentsService["validateFence"] = Effect.fn("Assignments.validateFence")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "share")
        yield* checkFence(row, input)
        if (!row.leaseLive) return yield* failure("stale-fence", "Executor assignment fence is stale")
        return yield* decodeAssignment(row)
      }),
    )
  })

  return { updateCapabilities, reconnect, heartbeat, authenticate, release, validateFence }
}
