import { HarnessOverview, HarnessRegistration, HarnessSnapshot, HarnessState } from "tenetkit/harness"
import type { AgentManifest } from "tenetkit"
import { Effect, Function, Schema } from "effect"

/** The capability name a pinned harness snapshot is registered under on every Rika Agent manifest. */
export const capabilityName = "rika-harness-snapshot"

export interface Pinned {
  readonly id: string
  readonly capability: AgentManifest.NamedCapability
  readonly payload: Schema.Json
  readonly overview: string
}

/**
 * Pin one exact harness state into the NEXT Execution.
 *
 * A running model turn never has its system prompt rewritten: a refinement applied during a Turn
 * produces a new snapshot id, and only the following Execution admits it. The bounded overview is
 * derived from the same state that is pinned, so a reconstruction that sees different entries fails
 * `SnapshotMismatch` rather than silently drifting.
 */
export const pin = (state: HarnessState.HarnessState): Pinned => {
  const registration = HarnessRegistration.registration(state, capabilityName)
  return {
    id: registration.id,
    capability: registration.capability,
    payload: Schema.decodeUnknownSync(Schema.Json)(registration.payload),
    overview: HarnessOverview.formatOverview(state),
  }
}

/** Reconstruct the exact state one pinned snapshot identifies, or fail typed on drift. */
export const reconstruct: {
  (
    payload: Schema.Json,
  ): (
    id: string,
  ) => Effect.Effect<HarnessState.HarnessState, HarnessSnapshot.SnapshotInvalid | HarnessSnapshot.SnapshotMismatch>
  (
    id: string,
    payload: Schema.Json,
  ): Effect.Effect<HarnessState.HarnessState, HarnessSnapshot.SnapshotInvalid | HarnessSnapshot.SnapshotMismatch>
} = Function.dual(2, (id: string, payload: Schema.Json) => HarnessSnapshot.decode(id, payload))
