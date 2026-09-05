import { Context, Effect, Option, Redacted, Schema } from "effect"
import type { ClientTicketResponse } from "@rika/product/client-protocol"
import type { Credential as OpenAiAccountCredential } from "@rika/product/openai-auth-contract"
import type { ExecutorKind } from "@rika/product/hosted-model"
import { ThreadSummary } from "@rika/product/thread-summary"
import type { EnvironmentPhase, EnvironmentScope } from "@rika/product/environment-policy"
import type { RepositoryService } from "@rika/product/workspace-capability"
import { Unit } from "@rika/transcript/transcript-unit"
import * as HostedIdentity from "@rika/product/hosted-identity-context"
import type {
  RunnerTarget,
  RunnerPollResult,
  RunnerProfile,
  RemoteThreadCreation,
} from "@rika/product/runner-registration"

export const defaultOrigin = "https://rika-app.up.railway.app"
export const scopes = "openid profile email offline_access account"

export class HostedError extends Schema.TaggedError<HostedError>()("HostedError", {
  kind: Schema.Literals([
    "denied",
    "expired",
    "host",
    "invalid-input",
    "login-required",
    "registration-required",
    "network",
    "protocol",
    "rate-limit",
    "storage",
  ]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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

interface CredentialBase {
  readonly refreshToken: Redacted.Redacted<string>
  readonly privateJwk: PrivateJwk
}

export type Credential = CredentialBase &
  (
    | {
        readonly accessToken: Redacted.Redacted<string>
        readonly accessTokenExpiresAt: number
      }
    | {
        readonly accessToken?: undefined
        readonly accessTokenExpiresAt?: undefined
      }
  )

export type ActiveCredential = CredentialBase & {
  readonly accessToken: Redacted.Redacted<string>
  readonly accessTokenExpiresAt: number
}

export interface Session {
  readonly accessToken: Redacted.Redacted<string>
  readonly privateJwk: PrivateJwk
}

export const Account = HostedIdentity.Account
export type Account = HostedIdentity.Account
export const Organization = HostedIdentity.Organization
export type Organization = HostedIdentity.Organization
export const Project = HostedIdentity.Project
export type Project = HostedIdentity.Project
export const IdentityContext = HostedIdentity.IdentityContext
export type IdentityContext = HostedIdentity.IdentityContext

export const OwnerSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("personal") }),
  Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.String }),
])
export type OwnerSelection = typeof OwnerSelection.Type

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

export const HostedThreadId = Schema.NonEmptyString
export type HostedThreadId = typeof HostedThreadId.Type

export const WorkspaceSeedUpload = Schema.Struct({
  id: Schema.NonEmptyString,
  contentDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  expiresAt: Schema.String,
})
export type WorkspaceSeedUpload = typeof WorkspaceSeedUpload.Type

export const isHostedThreadId = Schema.is(HostedThreadId)

export const HostedThreadList = Schema.Struct({ threads: Schema.Array(ThreadSummary) })
export type HostedThreadList = typeof HostedThreadList.Type
export const HostedThreadPreview = Schema.Struct({ units: Schema.Array(Unit) })
export type HostedThreadPreview = typeof HostedThreadPreview.Type

export const RecoveryInspection = Schema.Struct({
  runId: Schema.NonEmptyString,
  status: Schema.Literals([
    "queued",
    "running",
    "waiting",
    "needs-resolution",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  operationDetails: Schema.optional(Schema.TaggedStruct("Unavailable", { reason: Schema.String })),
})
export type RecoveryInspection = typeof RecoveryInspection.Type

export const RecoveryResolutionReceipt = Schema.Struct({
  runId: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
})
export type RecoveryResolutionReceipt = typeof RecoveryResolutionReceipt.Type

export type RecoveryResolution =
  | { readonly action: "retry" }
  | { readonly action: "accept"; readonly value: unknown }
  | { readonly action: "abort"; readonly reason: string }

export const RunRequest = Schema.Struct({
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  review: Schema.optionalKey(Schema.Literal(true)),
})
export type RunRequest = typeof RunRequest.Type

export const RunResult = Schema.Struct({
  commandId: Schema.String,
  status: Schema.Literals(["accepted", "queued"]),
  turnId: Schema.String,
  text: Schema.String,
})
export type RunResult = typeof RunResult.Type

export const EnvironmentReferenceStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: Schema.Literals(["personal", "organization", "project"]),
  classification: Schema.Literals(["plain", "secret"]),
  phases: Schema.Array(Schema.Literals(["setup", "runtime"])),
  revision: Schema.String,
  state: Schema.Literals(["active", "revoked"]),
})
export type EnvironmentReferenceStatus = typeof EnvironmentReferenceStatus.Type

export const RepositoryPublicationStatus = Schema.Struct({
  publicationId: Schema.String,
  state: Schema.Literals(["approved", "pushing", "pushed", "completed", "failed", "unknown"]),
  branch: Schema.String,
  ref: Schema.String,
  commitSha: Schema.String,
  targetBranch: Schema.String,
  targetCommitSha: Schema.String,
  targetProtected: Schema.Boolean,
  pushResult: Schema.NullOr(Schema.Unknown),
  pullRequestResult: Schema.NullOr(Schema.Unknown),
})
export type RepositoryPublicationStatus = typeof RepositoryPublicationStatus.Type

export interface ThreadClientInterface {
  readonly create: (input: {
    readonly ticket: ClientTicketResponse
    readonly commandId: string
    readonly owner: OwnerSelection
    readonly project?: string
    readonly executorKind: ExecutorKind
    readonly runnerTarget?: RunnerTarget
    readonly archiveThreadId?: HostedThreadId
    readonly workspaceSeedId?: string
  }) => Effect.Effect<HostedThreadId, HostedError>
  readonly submit: (input: {
    readonly ticket: ClientTicketResponse
    readonly threadId: HostedThreadId
    readonly request: RunRequest
    readonly commandId: string
  }) => Effect.Effect<RunResult, HostedError>
  readonly ensureService: (input: {
    readonly ticket: ClientTicketResponse
    readonly threadId: HostedThreadId
    readonly commandId: string
    readonly service: RepositoryService
  }) => Effect.Effect<void, HostedError>
  readonly stopService: (input: {
    readonly ticket: ClientTicketResponse
    readonly threadId: HostedThreadId
    readonly commandId: string
    readonly serviceId: string
  }) => Effect.Effect<void, HostedError>
  readonly openPortal: (input: {
    readonly ticket: ClientTicketResponse
    readonly threadId: HostedThreadId
    readonly requestId: string
    readonly port: number
  }) => Effect.Effect<string, HostedError>
}

export class ThreadClient extends Context.Service<ThreadClient, ThreadClientInterface>()(
  "@rika/cli/hosted/contract/ThreadClient",
) {}

export const ModelProvider = Schema.Literals(["openai", "anthropic", "openrouter"])
export type ModelProvider = typeof ModelProvider.Type
export const ProviderCredentialStatus = Schema.Struct({
  provider: ModelProvider,
  state: Schema.Literals(["active", "revoked"]),
  revision: Schema.String,
  credentialIdentity: Schema.String,
})
export type ProviderCredentialStatus = typeof ProviderCredentialStatus.Type
export const OpenAiAccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    state: Schema.Literals(["active", "revoked"]),
    revision: Schema.String,
    credentialIdentity: Schema.String,
    fingerprint: Schema.String,
  }),
])
export type OpenAiAccountStatus = typeof OpenAiAccountStatus.Type

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
  readonly issueThreadTicket: (origin: string, session: Session) => Effect.Effect<ClientTicketResponse, HostedError>
  readonly listThreads: (
    origin: string,
    owner: OwnerSelection,
    project: string | undefined,
    session: Session,
  ) => Effect.Effect<ReadonlyArray<ThreadSummary>, HostedError>
  readonly previewThread: (
    origin: string,
    threadId: string,
    session: Session,
  ) => Effect.Effect<ReadonlyArray<Unit>, HostedError>
  readonly inspectRecovery: (
    origin: string,
    threadId: string,
    runId: string,
    session: Session,
  ) => Effect.Effect<RecoveryInspection, HostedError>
  readonly resolveRecovery: (
    origin: string,
    threadId: string,
    runId: string,
    operationId: string,
    resolution: RecoveryResolution,
    operationKey: string,
    session: Session,
  ) => Effect.Effect<RecoveryResolutionReceipt, HostedError>
  readonly uploadWorkspaceSeed: (
    origin: string,
    archive: { readonly bytes: Uint8Array; readonly contentDigest: string; readonly sizeBytes: number },
    sourceRepository: { readonly owner: string; readonly name: string } | undefined,
    session: Session,
  ) => Effect.Effect<WorkspaceSeedUpload, HostedError>
  readonly registerRunner: (
    origin: string,
    checkoutFingerprint: string,
    registration: RunnerProfile,
    session: Session,
  ) => Effect.Effect<void, HostedError>
  readonly setRemoteThreadCreation: (
    origin: string,
    checkoutFingerprint: string,
    preference: RemoteThreadCreation,
    session: Session,
  ) => Effect.Effect<void, HostedError>
  readonly pollRunner: (
    origin: string,
    checkoutFingerprint: string,
    supervisorId: string,
    activeAssignmentIds: ReadonlyArray<string>,
    session: Session,
  ) => Effect.Effect<RunnerPollResult, HostedError>
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
  readonly putOpenAiAccount: (
    origin: string,
    owner: OwnerSelection,
    credential: OpenAiAccountCredential,
    session: Session,
  ) => Effect.Effect<OpenAiAccountStatus, HostedError>
  readonly getOpenAiAccount: (
    origin: string,
    owner: OwnerSelection,
    session: Session,
  ) => Effect.Effect<OpenAiAccountStatus, HostedError>
  readonly revokeOpenAiAccount: (
    origin: string,
    owner: OwnerSelection,
    session: Session,
  ) => Effect.Effect<OpenAiAccountStatus, HostedError>
  readonly createProject: (
    origin: string,
    owner: OwnerSelection,
    name: string,
    session: Session,
  ) => Effect.Effect<Project, HostedError>
  readonly putEnvironment: (
    origin: string,
    owner: OwnerSelection,
    project: string | undefined,
    name: string,
    scope: EnvironmentScope,
    phases: ReadonlyArray<EnvironmentPhase>,
    value: Redacted.Redacted<string>,
    session: Session,
  ) => Effect.Effect<EnvironmentReferenceStatus, HostedError>
  readonly revokeEnvironment: (
    origin: string,
    owner: OwnerSelection,
    project: string | undefined,
    name: string,
    scope: EnvironmentScope,
    session: Session,
  ) => Effect.Effect<EnvironmentReferenceStatus, HostedError>
  readonly publishRepository: (
    origin: string,
    threadId: string,
    commitSha: string,
    targetBranch: string | undefined,
    title: string,
    body: string,
    operationKey: string,
    session: Session,
  ) => Effect.Effect<RepositoryPublicationStatus, HostedError>
}

export class Http extends Context.Service<Http, HttpInterface>()("@rika/cli/hosted/contract/Http") {}

export interface CredentialStoreInterface {
  readonly load: (origin: string, deviceId: string) => Effect.Effect<Option.Option<Credential>, HostedError>
  readonly save: (origin: string, deviceId: string, credential: ActiveCredential) => Effect.Effect<void, HostedError>
  readonly remove: (origin: string, deviceId: string) => Effect.Effect<boolean, HostedError>
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | HostedError, R>
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreInterface>()(
  "@rika/cli/hosted/contract/CredentialStore",
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
  "@rika/cli/hosted/contract/ProfileStore",
) {}

export interface BrowserInterface {
  readonly open: (url: string) => Effect.Effect<void, HostedError>
}

export class Browser extends Context.Service<Browser, BrowserInterface>()("@rika/cli/hosted/contract/Browser") {}
