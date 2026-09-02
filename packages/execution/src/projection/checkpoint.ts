import * as Projection from "@rika/product/execution-projection"
import { Function, Schema } from "effect"
import type { AuthorizationState } from "./persistence"

const AuthorizationStateSchema = Schema.Struct({
  unitKey: Schema.String,
  rawRunId: Schema.String,
  authorizationId: Schema.String,
  approvalId: Schema.String,
})

const PresentationCheckpoint = Schema.Struct({
  turnId: Schema.String,
  authorizations: Schema.Array(Schema.Tuple([Schema.String, AuthorizationStateSchema])),
})

export const make = (input: {
  readonly turnId: string
  readonly cursor: string
  readonly authorizations: ReadonlyMap<string, AuthorizationState>
}): Projection.Checkpoint => ({
  version: Projection.projectionVersion,
  cursor: input.cursor,
  state: Schema.encodeSync(Schema.fromJsonString(PresentationCheckpoint))({
    turnId: input.turnId,
    authorizations: [...input.authorizations],
  }),
})

export interface AuthorizationTarget {
  readonly runId: string
  readonly approvalId: string
}

const authorizationTargetImpl = (
  checkpoint: Projection.Checkpoint,
  authorizationId: string,
): AuthorizationTarget | undefined => {
  if (checkpoint.version !== Projection.projectionVersion) return undefined
  let parsed: typeof PresentationCheckpoint.Type
  try {
    parsed = Schema.decodeSync(Schema.fromJsonString(PresentationCheckpoint))(checkpoint.state)
  } catch (cause) {
    throw new TypeError("Rika presentation checkpoint could not be decoded", { cause })
  }
  for (const [, value] of parsed.authorizations)
    if (value.authorizationId === authorizationId) return { runId: value.rawRunId, approvalId: value.approvalId }
  return undefined
}

export const authorizationTarget: {
  (
    arg0: Parameters<typeof authorizationTargetImpl>[0],
    arg1: Parameters<typeof authorizationTargetImpl>[1],
  ): ReturnType<typeof authorizationTargetImpl>
  (
    arg1: Parameters<typeof authorizationTargetImpl>[1],
  ): (arg0: Parameters<typeof authorizationTargetImpl>[0]) => ReturnType<typeof authorizationTargetImpl>
} = Function.dual(2, authorizationTargetImpl)
