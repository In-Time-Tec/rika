import { Schema } from "effect"

export const ProcessTerminalObservation = Schema.Struct({
  processId: Schema.String.check(Schema.isMinLength(1)),
  exitCode: Schema.Int,
  elapsedMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
})
export type ProcessTerminalObservation = typeof ProcessTerminalObservation.Type
