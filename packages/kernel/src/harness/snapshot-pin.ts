import { Overview, Registration, Snapshot, State } from "tenetkit/agent-guidance"
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
export const pin = (state: State.GuidanceState): Pinned => {
  const registration = Registration.make(state, capabilityName)
  return {
    id: registration.id,
    capability: registration.capability,
    payload: Schema.decodeSync(Schema.Json)(registration.payload),
    overview: Overview.format(state),
  }
}

/** Reconstruct the exact state one pinned snapshot identifies, or fail typed on drift. */
export const reconstruct: {
  (
    payload: Schema.Json,
  ): (id: string) => Effect.Effect<State.GuidanceState, Snapshot.SnapshotInvalid | Snapshot.SnapshotMismatch>
  (
    id: string,
    payload: Schema.Json,
  ): Effect.Effect<State.GuidanceState, Snapshot.SnapshotInvalid | Snapshot.SnapshotMismatch>
} = Function.dual(2, (id: string, payload: Schema.Json) =>
  Schema.decodeUnknownEffect(Snapshot.SnapshotPayload)(payload).pipe(
    Effect.mapError((issue) => Snapshot.SnapshotInvalid.make({ message: String(issue) })),
    Effect.flatMap((decoded) => Snapshot.decode(id, decoded)),
  ),
)
