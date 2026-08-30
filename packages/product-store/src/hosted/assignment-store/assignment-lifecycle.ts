import { Effect, Redacted } from "effect"
import { sql as expression } from "drizzle-orm"
import type { AssignmentsService } from "@rika/product/executor-assignments"
import { rikaHostedExecutorAssignments } from "../../database/schema/product"
import type { AssignmentOperations } from "./assignment-operations"

export const lifecycleOperations = (operations: AssignmentOperations) => {
  const { checkVersion, failure, locked, transaction, updated, updateVersion } = operations

  const pause: AssignmentsService["pause"] = Effect.fn("Assignments.pause")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "active") return yield* failure("invalid-state", "Assignment is not active")
        return yield* updated(
          tx,
          input.assignmentId,
          updateVersion(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lifecycle: "paused",
            bootstrapDigest: null,
            bootstrapExpiresAt: null,
            executorInstanceId: null,
            processIncarnation: null,
            sessionDigest: null,
            leaseEpoch: null,
            leaseExpiresAt: null,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  const resume: AssignmentsService["resume"] = Effect.fn("Assignments.resume")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "paused") return yield* failure("invalid-state", "Assignment is not paused")
        return yield* updated(
          tx,
          input.assignmentId,
          updateVersion(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lifecycle: "provisioning",
            bootstrapDigest: Redacted.value(input.bootstrapCredentialDigest),
            bootstrapExpiresAt: expression`transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond')`,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  const terminate: AssignmentsService["terminate"] = Effect.fn("Assignments.terminate")(function* (input) {
    return yield* transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        return yield* updated(
          tx,
          input.assignmentId,
          updateVersion(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lifecycle: "terminated",
            bootstrapDigest: null,
            bootstrapExpiresAt: null,
            executorInstanceId: null,
            processIncarnation: null,
            sessionDigest: null,
            leaseEpoch: null,
            leaseExpiresAt: null,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  return { pause, resume, terminate }
}
