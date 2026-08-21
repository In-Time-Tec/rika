import { Context, Effect, Option, Redacted, Schema } from "effect"
import type { ClientTicketResponse } from "@rika/product/client-protocol"
import type {
  LocalRunnerPollResult,
  LocalRunnerProfile,
  RemoteThreadCreation,
} from "@rika/product/local-runner-registration"

export const defaultOrigin = "https://rika-app.up.railway.app"
export const scopes = "openid profile email offline_access account"

export class HostedError extends Schema.TaggedError<HostedError>()("HostedError", {
  kind: Schema.Literals([
    "denied",
    "expired",
    "host",
    "invalid-input",
    "login-required",
    "network",
    "protocol",
    "storage",
  ]),
  message: Schema.String,
}) {}

export const PublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
})
export type PublicJwk = typeof PublicJwk.Type

export const PrivateJwk = Schema.Struct({
  ...PublicJwk.fields,
  d: Schema.String,
})
export type PrivateJwk = typeof PrivateJwk.Type

export const Registration = Schema.Struct({ clientId: Schema.String })
export type Registration = typeof Registration.Type

export const DeviceAuthorization = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  verificationUriComplete: Schema.optionalKey(Schema.String),
  expiresIn: Schema.Int,
  interval: Schema.Int,
})
export type DeviceAuthorization = typeof DeviceAuthorization.Type

export const TokenSet = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresIn: Schema.Int,
})
export type TokenSet = typeof TokenSet.Type

export type DevicePoll =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "SlowDown" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Complete"; readonly tokens: TokenSet }

export interface Credential {
  readonly refreshToken: Redacted.Redacted<string>
  readonly privateJwk: PrivateJwk
}

export interface Session {
  readonly accessToken: Redacted.Redacted<string>
  readonly privateJwk: PrivateJwk
}

export const Account = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
})
export type Account = typeof Account.Type

export const Organization = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
})
export type Organization = typeof Organization.Type

export const OwnerSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("personal") }),
  Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.String }),
])
export type OwnerSelection = typeof OwnerSelection.Type

const ProjectOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("personal"), userId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.String }),
])

export const Project = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  owner: ProjectOwner,
  slug: Schema.String,
  name: Schema.String,
})
export type Project = typeof Project.Type

export const IdentityContext = Schema.Struct({
  account: Account,
  organizations: Schema.Array(Organization),
  projects: Schema.optionalKey(Schema.Array(Project)),
})
export type IdentityContext = typeof IdentityContext.Type

export const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  status: Schema.optionalKey(Schema.String),
})
export type Invitation = typeof Invitation.Type

export const CliDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  current: Schema.optionalKey(Schema.Boolean),
  lastSeenAt: Schema.optionalKey(Schema.String),
})
export type CliDevice = typeof CliDevice.Type

export const RemoteConnection = Schema.Struct({
  threadId: Schema.String,
  url: Schema.optionalKey(Schema.String),
})
export type RemoteConnection = typeof RemoteConnection.Type

export const HostedThreadId = Schema.NonEmptyString
export type HostedThreadId = typeof HostedThreadId.Type

export const isHostedThreadId = Schema.is(HostedThreadId)

export const RunRequest = Schema.Struct({
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Schema.String),
})
export type RunRequest = typeof RunRequest.Type

export const RunResult = Schema.Struct({
  commandId: Schema.String,
  turnId: Schema.String,
  status: Schema.Literal("queued"),
})
export type RunResult = typeof RunResult.Type

export const ModelProvider = Schema.Literals(["openai", "anthropic", "openrouter"])
export type ModelProvider = typeof ModelProvider.Type
export const ProviderCredentialStatus = Schema.Struct({
  provider: ModelProvider,
  state: Schema.Literals(["active", "revoked"]),
  revision: Schema.String,
  credentialIdentity: Schema.String,
})
export type ProviderCredentialStatus = typeof ProviderCredentialStatus.Type

export interface HttpInterface {
  readonly register: (
    origin: string,
    deviceId: string,
    publicJwk: PublicJwk,
    thumbprint: string,
  ) => Effect.Effect<Registration, HostedError>
  readonly startDeviceAuthorization: (
    origin: string,
    clientId: string,
    privateJwk: PrivateJwk,
  ) => Effect.Effect<DeviceAuthorization, HostedError>
  readonly pollDeviceAuthorization: (
    origin: string,
    clientId: string,
    deviceCode: Redacted.Redacted<string>,
    privateJwk: PrivateJwk,
  ) => Effect.Effect<DevicePoll, HostedError>
  readonly refresh: (
    origin: string,
    clientId: string,
    refreshToken: Redacted.Redacted<string>,
    privateJwk: PrivateJwk,
  ) => Effect.Effect<TokenSet, HostedError>
  readonly context: (origin: string, session: Session) => Effect.Effect<IdentityContext, HostedError>
  readonly invite: (
    origin: string,
    organization: string,
    email: string,
    session: Session,
  ) => Effect.Effect<Invitation, HostedError>
  readonly devices: (origin: string, session: Session) => Effect.Effect<ReadonlyArray<CliDevice>, HostedError>
  readonly revokeDevice: (origin: string, deviceId: string, session: Session) => Effect.Effect<void, HostedError>
  readonly revokeAllDevices: (origin: string, session: Session) => Effect.Effect<void, HostedError>
  readonly createRemoteConnection: (
    origin: string,
    owner: OwnerSelection,
    project: string | undefined,
    session: Session,
  ) => Effect.Effect<RemoteConnection, HostedError>
  readonly runThread: (
    origin: string,
    threadId: HostedThreadId,
    request: RunRequest,
    idempotencyKey: string,
    session: Session,
  ) => Effect.Effect<RunResult, HostedError>
  readonly issueThreadTicket: (
    origin: string,
    session: Session,
  ) => Effect.Effect<ClientTicketResponse, HostedError>
  readonly registerLocalRunner: (
    origin: string,
    checkoutFingerprint: string,
    registration: LocalRunnerProfile,
    session: Session,
  ) => Effect.Effect<void, HostedError>
  readonly setRemoteThreadCreation: (
    origin: string,
    checkoutFingerprint: string,
    preference: RemoteThreadCreation,
    session: Session,
  ) => Effect.Effect<void, HostedError>
  readonly pollLocalRunner: (
    origin: string,
    checkoutFingerprint: string,
    session: Session,
  ) => Effect.Effect<LocalRunnerPollResult, HostedError>
  readonly putProviderCredential: (
    origin: string,
    owner: OwnerSelection,
    provider: ModelProvider,
    apiKey: Redacted.Redacted<string>,
    session: Session,
  ) => Effect.Effect<ProviderCredentialStatus, HostedError>
  readonly listProviderCredentials: (
    origin: string,
    owner: OwnerSelection,
    session: Session,
  ) => Effect.Effect<ReadonlyArray<ProviderCredentialStatus>, HostedError>
  readonly revokeProviderCredential: (
    origin: string,
    owner: OwnerSelection,
    provider: ModelProvider,
    session: Session,
  ) => Effect.Effect<ProviderCredentialStatus, HostedError>
}

export class Http extends Context.Service<Http, HttpInterface>()("@rika/cli/hosted/hosted-contract/Http") {}

export interface CredentialStoreInterface {
  readonly load: (origin: string, deviceId: string) => Effect.Effect<Option.Option<Credential>, HostedError>
  readonly save: (origin: string, deviceId: string, credential: Credential) => Effect.Effect<void, HostedError>
  readonly remove: (origin: string, deviceId: string) => Effect.Effect<boolean, HostedError>
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreInterface>()(
  "@rika/cli/hosted/hosted-contract/CredentialStore",
) {}

export interface Profile {
  readonly origin: string
  readonly deviceId: string
  readonly clientId: string
  readonly owner: OwnerSelection
  readonly project?: string | undefined
}

export interface ProfileStoreInterface {
  readonly load: Effect.Effect<Option.Option<Profile>, HostedError>
  readonly save: (profile: Profile) => Effect.Effect<void, HostedError>
}

export class ProfileStore extends Context.Service<ProfileStore, ProfileStoreInterface>()(
  "@rika/cli/hosted/hosted-contract/ProfileStore",
) {}

export interface BrowserInterface {
  readonly open: (url: string) => Effect.Effect<void, HostedError>
}

export class Browser extends Context.Service<Browser, BrowserInterface>()("@rika/cli/hosted/hosted-contract/Browser") {}
