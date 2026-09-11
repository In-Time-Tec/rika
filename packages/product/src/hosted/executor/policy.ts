import { Schema } from "effect"
import { OrbPlacement, RunnerPlacement } from "./assignment"

export const ExecutorPolicy = Schema.Struct({
  buildId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  protocolVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1024)),
})
export type ExecutorPolicy = typeof ExecutorPolicy.Type

export const currentExecutorPolicy: ExecutorPolicy = {
  buildId: "rika-executor-v2@1",
  protocolVersion: 1,
}

export const ExecutorPlacementPolicy = Schema.Union([
  Schema.Struct({ ...RunnerPlacement.fields, executorPolicy: ExecutorPolicy }),
  Schema.Struct({
    ...OrbPlacement.fields,
    executorPolicy: ExecutorPolicy,
    lineageId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  }),
])
export type ExecutorPlacementPolicy = typeof ExecutorPlacementPolicy.Type
