import type { Deferred, Effect } from "effect"
import { Schema } from "effect"
import { AccessWire, RunnerAdmissionWire } from "../../protocol/messages"
import { State as MachineState } from "../machinery/machine"

export interface ForegroundRunnerOptions {
  readonly admission?: RunnerAdmissionWire
  readonly resume?: ForegroundRunnerSnapshot
  readonly workspacePath: string
  readonly ready?: Deferred.Deferred<void, ForegroundRunnerError>
  readonly trustedOrigin?: string
  readonly receiptStore?: ForegroundRunnerReceiptStore
  readonly receiptScope?: string
}

export class ForegroundRunnerError extends Schema.TaggedError<ForegroundRunnerError>()("ForegroundRunnerError", {
  message: Schema.String,
}) {}

export const ForegroundRunnerSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  workspaceIdentity: Schema.String.check(Schema.isMinLength(1)),
  executorUrl: Schema.String.check(Schema.isMinLength(1)),
  access: AccessWire,
  leaseExpiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: Schema.Struct({ sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), value: Schema.String }),
  machines: Schema.Array(Schema.Struct({ machineId: Schema.String, state: MachineState })),
})
export type ForegroundRunnerSnapshot = typeof ForegroundRunnerSnapshot.Type

export interface ForegroundRunnerReceiptStore {
  readonly save: (scope: string, snapshot: ForegroundRunnerSnapshot) => Effect.Effect<void, ForegroundRunnerError>
}
