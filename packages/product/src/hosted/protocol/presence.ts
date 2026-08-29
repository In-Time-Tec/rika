import { Context, Effect } from "effect"
import type { ActorAttribution, OwnerId, Presence, PresenceStatus, ThreadId, Timestamp } from "../model"
import type { HostedPersistenceError } from "../persistence-error"

export interface HostedThreadPresenceInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly actor: ActorAttribution
}

export interface UpsertHostedPresenceInput extends HostedThreadPresenceInput {
  readonly status: PresenceStatus
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface HostedPresenceService {
  readonly upsert: (input: UpsertHostedPresenceInput) => Effect.Effect<Presence, HostedPersistenceError>
  readonly list: (
    input: HostedThreadPresenceInput & { readonly now: Timestamp },
  ) => Effect.Effect<ReadonlyArray<Presence>, HostedPersistenceError>
}

export class HostedPresence extends Context.Service<HostedPresence, HostedPresenceService>()(
  "@rika/product/hosted/protocol/presence/HostedPresence",
) {}
