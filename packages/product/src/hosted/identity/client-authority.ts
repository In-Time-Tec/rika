import { Context, Effect } from "effect"
import type { AuthorizationAction } from "./authorization"
import type {
  ActorAttribution,
  AuthenticatedClient,
  AuthenticatedDevice,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  HostedThread,
  OwnerId,
  ThreadId,
  Timestamp,
} from "../model"
import type { HostedPersistenceError } from "../persistence-error"

export interface RegisterDeviceInput {
  readonly id: DeviceId
  readonly userId: BetterAuthUserId
  readonly displayName: string
  readonly publicKeyFingerprint: string
  readonly now: Timestamp
}

export interface AuthenticateClientInput {
  readonly id: ClientId
  readonly userId: BetterAuthUserId
  readonly deviceId: DeviceId
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface GrantClientAuthorityInput {
  readonly ownerId: OwnerId
  readonly actor: ActorAttribution
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface ReadHostedThreadInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
}

export interface AuthorizeHostedThreadInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly actor: ActorAttribution
  readonly action: AuthorizationAction
  readonly at?: Timestamp
}

export interface HostedClientAuthorityService {
  readonly registerDevice: (input: RegisterDeviceInput) => Effect.Effect<AuthenticatedDevice, HostedPersistenceError>
  readonly authenticateClient: (
    input: AuthenticateClientInput,
  ) => Effect.Effect<AuthenticatedClient, HostedPersistenceError>
  readonly grantClientAuthority: (input: GrantClientAuthorityInput) => Effect.Effect<void, HostedPersistenceError>
  readonly findThread: (threadId: ThreadId) => Effect.Effect<HostedThread | undefined, HostedPersistenceError>
  readonly readThread: (input: ReadHostedThreadInput) => Effect.Effect<HostedThread | undefined, HostedPersistenceError>
  readonly authorizeThread: (input: AuthorizeHostedThreadInput) => Effect.Effect<void, HostedPersistenceError>
}

export class HostedClientAuthority extends Context.Service<HostedClientAuthority, HostedClientAuthorityService>()(
  "@rika/product/hosted/identity/client-authority/HostedClientAuthority",
) {}
