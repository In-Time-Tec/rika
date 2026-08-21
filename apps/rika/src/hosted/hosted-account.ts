import { Clock, Console, Crypto, Effect, Option, Redacted, Result, Schema } from "effect"
import {
  Browser,
  CredentialStore,
  defaultOrigin,
  HostedError,
  Http,
  ProfileStore,
  type Credential,
  type DeviceAuthorization,
  type PrivateJwk,
  type Profile,
  type IdentityContext,
  type Session,
  type ModelProvider,
  type TokenSet,
} from "./hosted-contract"
import type { RunRequest } from "./hosted-contract"
import * as Dpop from "./hosted-dpop"

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })
const emailSchema = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))

export const normalizeOrigin = Effect.fn("HostedAccount.normalizeOrigin")(function* (raw: string) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(raw).pipe(
    Effect.mapError(() => failure("invalid-input", "Hosted origin must be a valid HTTP or HTTPS URL")),
  )
  if (
    (decoded.protocol !== "https:" && decoded.protocol !== "http:") ||
    decoded.username.length > 0 ||
    decoded.password.length > 0 ||
    decoded.search.length > 0 ||
    decoded.hash.length > 0
  )
    return yield* failure("invalid-input", "Hosted origin must be an HTTP or HTTPS base URL without credentials")
  return `${decoded.origin}${decoded.pathname === "/" ? "" : decoded.pathname.replace(/\/+$/, "")}`
})

export const pollDeviceAuthorization = Effect.fn("HostedAccount.pollDeviceAuthorization")(function* (
  profile: Pick<Profile, "origin" | "clientId">,
  privateJwk: PrivateJwk,
  authorization: DeviceAuthorization,
  issuedAt?: number,
) {
  const http = yield* Http
  const deadline = (issuedAt ?? (yield* Clock.currentTimeMillis)) + authorization.expiresIn * 1000
  let interval = authorization.interval * 1000
  while (true) {
    const beforeSleep = yield* Clock.currentTimeMillis
    if (beforeSleep + interval >= deadline) {
      yield* Effect.sleep(Math.max(0, deadline - beforeSleep))
      return yield* failure("expired", "Device authorization expired")
    }
    yield* Effect.sleep(interval)
    const polled = yield* http
      .pollDeviceAuthorization(profile.origin, profile.clientId, Redacted.make(authorization.deviceCode), privateJwk)
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error.kind === "network" ? Effect.succeed({ _tag: "NetworkFailure" as const }) : Effect.fail(error),
          onSuccess: Effect.succeed,
        }),
      )
    if ((yield* Clock.currentTimeMillis) >= deadline) return yield* failure("expired", "Device authorization expired")
    if (polled._tag === "NetworkFailure" || polled._tag === "Pending") continue
    if (polled._tag === "SlowDown") {
      interval += 5_000
      continue
    }
    if (polled._tag === "Denied") return yield* failure("denied", "Device authorization was denied")
    if (polled._tag === "Expired") return yield* failure("expired", "Device authorization expired")
    return polled.tokens
  }
})

const credentialFrom = (tokens: TokenSet, privateJwk: PrivateJwk): Credential => ({
  refreshToken: Redacted.make(tokens.refreshToken),
  privateJwk,
})

const sessionFrom = (tokens: TokenSet, privateJwk: PrivateJwk): Session => ({
  accessToken: Redacted.make(tokens.accessToken),
  privateJwk,
})

const selectedProfile = Effect.fn("HostedAccount.profile")(function* () {
  const store = yield* ProfileStore
  const loaded = yield* store.load
  if (Option.isNone(loaded)) return yield* failure("login-required", "Run rika auth login first")
  return loaded.value
})

const refresh = Effect.fn("HostedAccount.refresh")(function* (profile: Profile, current: Credential) {
  const http = yield* Http
  const store = yield* CredentialStore
  return yield* Effect.uninterruptibleMask((restore) =>
    restore(http.refresh(profile.origin, profile.clientId, current.refreshToken, current.privateJwk)).pipe(
      Effect.flatMap((tokens) =>
        store
          .save(profile.origin, profile.deviceId, credentialFrom(tokens, current.privateJwk))
          .pipe(Effect.as(sessionFrom(tokens, current.privateJwk))),
      ),
    ),
  )
})

const authenticated = <A>(
  profile: Profile,
  request: (session: Session) => Effect.Effect<A, HostedError>,
): Effect.Effect<A, HostedError, Http | CredentialStore> =>
  Effect.gen(function* () {
    const store = yield* CredentialStore
    const current = yield* store.load(profile.origin, profile.deviceId)
    if (Option.isNone(current)) return yield* failure("login-required", "Run rika auth login first")
    const session = yield* refresh(profile, current.value)
    return yield* request(session)
  })

const json = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError(() => failure("protocol", "Hosted output could not be encoded")),
  )

const validOwner = (profile: Profile, identity: IdentityContext) => {
  if (profile.owner.kind === "personal") return true
  const organizationId = profile.owner.organizationId
  return identity.organizations.some((organization) => organization.id === organizationId)
}

const staleOwner = () =>
  failure(
    "invalid-input",
    "Selected organization is no longer available; run rika org personal or rika org use <organization>",
  )

export const login = Effect.fn("HostedAccount.login")(function* (input: {
  readonly server?: string | undefined
  readonly noOpen: boolean
}) {
  const http = yield* Http
  const credentials = yield* CredentialStore
  const profiles = yield* ProfileStore
  const browser = yield* Browser
  const crypto = yield* Crypto.Crypto
  const existing = yield* profiles.load
  const previous = Option.getOrUndefined(existing)
  const origin = yield* normalizeOrigin(input.server ?? previous?.origin ?? defaultOrigin)
  const reusable =
    previous !== undefined && previous.origin === origin
      ? yield* credentials.load(previous.origin, previous.deviceId)
      : Option.none<Credential>()
  const privateJwk = Option.isSome(reusable) ? reusable.value.privateJwk : yield* Dpop.generate()
  const deviceId = Option.isSome(reusable)
    ? previous!.deviceId
    : yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => failure("host", "Could not identify this installation")))
  const clientId = Option.isSome(reusable)
    ? previous!.clientId
    : (yield* http.register(
        origin,
        deviceId,
        Dpop.publicJwk(privateJwk),
        yield* Dpop.thumbprint(Dpop.publicJwk(privateJwk)),
      )).clientId
  const nextProfile: Profile = {
    origin,
    deviceId,
    clientId,
    owner: previous !== undefined && previous.origin === origin ? previous.owner : { kind: "personal" },
    ...(previous !== undefined && previous.origin === origin ? { project: previous.project } : {}),
  }
  const authorization = yield* http.startDeviceAuthorization(origin, clientId, privateJwk)
  const issuedAt = yield* Clock.currentTimeMillis
  const verification = authorization.verificationUriComplete ?? authorization.verificationUri
  yield* Console.log(`Open ${verification}\nEnter code: ${authorization.userCode}`)
  if (!input.noOpen)
    yield* browser
      .open(verification)
      .pipe(Effect.catch((error) => Console.error(`${error.message}; continue with the URL above`)))
  const tokens = yield* pollDeviceAuthorization(nextProfile, privateJwk, authorization, issuedAt)
  const identity = yield* http.context(origin, sessionFrom(tokens, privateJwk))
  const selected = validOwner(nextProfile, identity)
    ? nextProfile
    : { ...nextProfile, owner: { kind: "personal" as const }, project: undefined }
  yield* profiles.save(selected)
  yield* credentials.save(origin, deviceId, credentialFrom(tokens, privateJwk))
  yield* Console.log(`Logged in as ${identity.account.email}`)
})

export const status = Effect.fn("HostedAccount.status")(function* (asJson: boolean) {
  const profiles = yield* ProfileStore
  const credentials = yield* CredentialStore
  const http = yield* Http
  const loaded = yield* profiles.load
  if (Option.isNone(loaded)) {
    yield* Console.log(asJson ? yield* json({ authenticated: false }) : "Not logged in")
    return
  }
  const credential = yield* credentials.load(loaded.value.origin, loaded.value.deviceId)
  if (Option.isNone(credential)) {
    yield* Console.log(
      asJson
        ? yield* json({ authenticated: false, origin: loaded.value.origin, deviceId: loaded.value.deviceId })
        : `Not logged in\nOrigin: ${loaded.value.origin}`,
    )
    return
  }
  const identity = yield* authenticated(loaded.value, (session) => http.context(loaded.value.origin, session))
  if (asJson) {
    yield* Console.log(
      yield* json({
        authenticated: true,
        origin: loaded.value.origin,
        deviceId: loaded.value.deviceId,
        account: identity.account,
        owner: loaded.value.owner,
        ...(loaded.value.project === undefined ? {} : { project: loaded.value.project }),
      }),
    )
    return
  }
  yield* Console.log(
    `Logged in as ${identity.account.email}\nOrigin: ${loaded.value.origin}\nOwner: ${
      loaded.value.owner.kind === "personal" ? "Personal" : `Organization ${loaded.value.owner.organizationId}`
    }${loaded.value.project === undefined ? "" : `\nProject: ${loaded.value.project}`}`,
  )
})

export const logout = Effect.fn("HostedAccount.logout")(function* () {
  const profiles = yield* ProfileStore
  const loaded = yield* profiles.load
  if (Option.isNone(loaded)) {
    yield* Console.log("Not logged in")
    return
  }
  const credentials = yield* CredentialStore
  const http = yield* Http
  const profile = loaded.value
  const current = yield* credentials.load(profile.origin, profile.deviceId)
  if (Option.isNone(current)) {
    yield* Console.log("Not logged in")
    return
  }
  const revoked = yield* Effect.result(
    authenticated(profile, (session) => http.revokeDevice(profile.origin, profile.deviceId, session)),
  )
  yield* credentials.remove(profile.origin, profile.deviceId)
  if (Result.isFailure(revoked)) return yield* revoked.failure
  yield* Console.log("Logged out")
})

export const logoutAll = Effect.fn("HostedAccount.logoutAll")(function* () {
  const profiles = yield* ProfileStore
  const loaded = yield* profiles.load
  if (Option.isNone(loaded)) {
    yield* Console.log("Not logged in")
    return
  }
  const credentials = yield* CredentialStore
  const http = yield* Http
  const profile = loaded.value
  const current = yield* credentials.load(profile.origin, profile.deviceId)
  if (Option.isNone(current)) {
    yield* Console.log("Not logged in")
    return
  }
  yield* authenticated(profile, (session) => http.revokeAllDevices(profile.origin, session))
  yield* credentials.remove(profile.origin, profile.deviceId)
  yield* Console.log("Logged out of all CLI devices")
})

export const devices = Effect.fn("HostedAccount.devices")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const values = yield* authenticated(profile, (session) => http.devices(profile.origin, session))
  if (values.length === 0) {
    yield* Console.log("No CLI devices")
    return
  }
  for (const device of values)
    yield* Console.log(
      `${device.id === profile.deviceId || device.current === true ? "*" : " "} ${device.name ?? device.id}${
        device.lastSeenAt === undefined ? "" : ` (${device.lastSeenAt})`
      }`,
    )
})

export const revokeDevice = Effect.fn("HostedAccount.revokeDevice")(function* (requested?: string) {
  const profile = yield* selectedProfile()
  const credentials = yield* CredentialStore
  const http = yield* Http
  const deviceId = requested ?? profile.deviceId
  yield* authenticated(profile, (session) => http.revokeDevice(profile.origin, deviceId, session))
  if (deviceId === profile.deviceId) yield* credentials.remove(profile.origin, profile.deviceId)
  yield* Console.log(`Revoked CLI device ${deviceId}`)
})

export const listOrganizations = Effect.fn("HostedAccount.listOrganizations")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const identity = yield* authenticated(profile, (session) => http.context(profile.origin, session))
  yield* Console.log(`${profile.owner.kind === "personal" ? "*" : " "} Personal`)
  for (const organization of identity.organizations)
    yield* Console.log(
      `${profile.owner.kind === "organization" && profile.owner.organizationId === organization.id ? "*" : " "} ${organization.name} (${organization.slug})`,
    )
})

export const usePersonalOwner = Effect.fn("HostedAccount.usePersonalOwner")(function* () {
  const profile = yield* selectedProfile()
  const profiles = yield* ProfileStore
  yield* profiles.save({ ...profile, owner: { kind: "personal" }, project: undefined })
  yield* Console.log("Using Personal")
})

export const useOrganization = Effect.fn("HostedAccount.useOrganization")(function* (requested: string) {
  const profile = yield* selectedProfile()
  const profiles = yield* ProfileStore
  const http = yield* Http
  const identity = yield* authenticated(profile, (session) => http.context(profile.origin, session))
  const matches = identity.organizations.filter(
    (organization) =>
      organization.id === requested || organization.slug === requested || organization.name === requested,
  )
  if (matches.length !== 1)
    return yield* failure(
      "invalid-input",
      matches.length === 0 ? `Organization ${requested} was not found` : `Organization ${requested} is ambiguous`,
    )
  yield* profiles.save({
    ...profile,
    owner: { kind: "organization", organizationId: matches[0]!.id },
    project: undefined,
  })
  yield* Console.log(`Using organization ${matches[0]!.name}`)
})

export const invite = Effect.fn("HostedAccount.invite")(function* (rawEmail: string) {
  const email = yield* Schema.decodeUnknownEffect(emailSchema)(rawEmail).pipe(
    Effect.mapError(() => failure("invalid-input", "Invitation email is invalid")),
  )
  const profile = yield* selectedProfile()
  if (profile.owner.kind !== "organization") return yield* failure("invalid-input", "Run rika org use first")
  const organizationId = profile.owner.organizationId
  const http = yield* Http
  const invitation = yield* authenticated(profile, (session) =>
    http.invite(profile.origin, organizationId, email, session),
  )
  yield* Console.log(`Invited ${invitation.email}`)
})

export const createRemoteThread = Effect.fn("HostedAccount.createRemoteThread")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const connection = yield* authenticated(profile, (session) =>
    http.context(profile.origin, session).pipe(
      Effect.filterOrFail((identity) => validOwner(profile, identity), staleOwner),
      Effect.flatMap(() => http.createRemoteConnection(profile.origin, profile.owner, profile.project, session)),
    ),
  )
  yield* Console.log(
    `Created remote E2B thread ${connection.threadId}${connection.url === undefined ? "" : `\n${connection.url}`}`,
  )
})

export const runThread = Effect.fn("HostedAccount.runThread")(function* (threadId: string, request: RunRequest) {
  const profile = yield* selectedProfile()
  const crypto = yield* Crypto.Crypto
  const http = yield* Http
  const key = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("host", "Could not create a hosted operation identifier")),
  )
  const result = yield* authenticated(profile, (session) =>
    http.runThread(profile.origin, threadId, request, key, session),
  )
  yield* Console.log(`Queued turn ${result.turnId} for command ${result.commandId}`)
})

export const putProviderCredential = Effect.fn("HostedAccount.putProviderCredential")(function* (
  provider: ModelProvider,
  apiKey: string,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.putProviderCredential(profile.origin, profile.owner, provider, Redacted.make(apiKey), session),
  )
  yield* Console.log(`${result.provider} credential is ${result.state} at revision ${result.revision}`)
})

export const listProviderCredentials = Effect.fn("HostedAccount.listProviderCredentials")(function* (
  provider?: ModelProvider,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const statuses = yield* authenticated(profile, (session) =>
    http.listProviderCredentials(profile.origin, profile.owner, session),
  )
  const selected = provider === undefined ? statuses : statuses.filter((entry) => entry.provider === provider)
  if (selected.length === 0) {
    yield* Console.log(
      provider === undefined ? "No provider credentials configured" : `${provider} credential is missing`,
    )
    return
  }
  for (const entry of selected) {
    yield* Console.log(`${entry.provider}\t${entry.state}\trevision ${entry.revision}`)
  }
})

export const revokeProviderCredential = Effect.fn("HostedAccount.revokeProviderCredential")(function* (
  provider: ModelProvider,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.revokeProviderCredential(profile.origin, profile.owner, provider, session),
  )
  yield* Console.log(`${result.provider} credential is ${result.state} at revision ${result.revision}`)
})
