import { Clock, Console, Crypto, Effect, Option, Redacted, Result, Schema } from "effect"
import {
  Browser,
  CredentialStore,
  defaultOrigin,
  HostedError,
  Http,
  ProfileStore,
  type ActiveCredential,
  type Credential,
  type DeviceAuthorization,
  type PrivateJwk,
  type Profile,
  type Session,
  type TokenSet,
} from "../contract"
import * as Dpop from "../dpop"
import { accountSupport } from "./support"

const { failure, json, validOwner } = accountSupport

export const normalizeOrigin = Effect.fn("HostedAccount.normalizeOrigin")(function* (raw: string) {
  const decoded = yield* Schema.decodeEffect(Schema.URLFromString)(raw).pipe(
    Effect.mapError(() => failure("invalid-input", "Server origin must be a valid HTTP or HTTPS URL")),
  )
  if (
    (decoded.protocol !== "https:" && decoded.protocol !== "http:") ||
    decoded.username.length > 0 ||
    decoded.password.length > 0 ||
    decoded.search.length > 0 ||
    decoded.hash.length > 0
  )
    return yield* failure("invalid-input", "Server origin must be an HTTP or HTTPS base URL without credentials")
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
            error.kind === "network" || error.kind === "rate-limit"
              ? Effect.succeed({ _tag: "TransientFailure" as const, retryAfterMillis: error.retryAfterMillis })
              : Effect.fail(error),
          onSuccess: Effect.succeed,
        }),
      )
    if ((yield* Clock.currentTimeMillis) >= deadline) return yield* failure("expired", "Device authorization expired")
    if (polled._tag === "TransientFailure") {
      interval = Math.max(interval, polled.retryAfterMillis ?? 0)
      continue
    }
    if (polled._tag === "Pending") continue
    if (polled._tag === "SlowDown") {
      interval += 5_000
      continue
    }
    if (polled._tag === "Denied") return yield* failure("denied", "Device authorization was denied")
    if (polled._tag === "Expired") return yield* failure("expired", "Device authorization expired")
    return polled.tokens
  }
})

const credentialFrom = (tokens: TokenSet, privateJwk: PrivateJwk, receivedAt: number): ActiveCredential => ({
  refreshToken: Redacted.make(tokens.refreshToken),
  privateJwk,
  accessToken: Redacted.make(tokens.accessToken),
  accessTokenExpiresAt: receivedAt + tokens.expiresIn * 1_000,
})

const sessionFrom = (tokens: TokenSet, privateJwk: PrivateJwk): Session => ({
  accessToken: Redacted.make(tokens.accessToken),
  privateJwk,
})

const sessionFromCredential = (credential: ActiveCredential): Session => ({
  accessToken: credential.accessToken,
  privateJwk: credential.privateJwk,
})

const activeCredential = (credential: Credential, now: number): credential is ActiveCredential =>
  credential.accessToken !== undefined && credential.accessTokenExpiresAt > now + 30_000

export const selectedProfile = Effect.fn("HostedAccount.profile")(function* () {
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
      Effect.tap(() => Effect.logInfo("auth.refresh.success")),
      Effect.tapError((error) => {
        const category = {
          "rika.failure.category": error.kind === "rate-limit" ? "rate_limited" : "dependency_unavailable",
        }
        const status = error.status === undefined ? category : { ...category, "rika.http.status": error.status }
        const annotations =
          error.retryAfterMillis === undefined ? status : { ...status, "rika.retry_after.ms": error.retryAfterMillis }
        return Effect.logWarning("auth.refresh.failure").pipe(Effect.annotateLogs(annotations))
      }),
      Effect.flatMap((tokens) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((receivedAt) => credentialFrom(tokens, current.privateJwk, receivedAt)),
          Effect.tap((credential) => store.save(profile.origin, profile.deviceId, credential)),
        ),
      ),
    ),
  )
})

const acquireSession = Effect.fn("HostedAccount.acquireSession")(function* (profile: Profile) {
  const store = yield* CredentialStore
  const loaded = yield* store.load(profile.origin, profile.deviceId)
  if (Option.isNone(loaded)) return yield* failure("login-required", "Run rika auth login first")
  if (activeCredential(loaded.value, yield* Clock.currentTimeMillis)) return sessionFromCredential(loaded.value)
  const credential = yield* store.serialized(
    Effect.gen(function* () {
      const current = yield* store.load(profile.origin, profile.deviceId)
      if (Option.isNone(current)) return yield* failure("login-required", "Run rika auth login first")
      if (activeCredential(current.value, yield* Clock.currentTimeMillis)) return current.value
      return yield* refresh(profile, current.value)
    }),
  )
  return sessionFromCredential(credential)
})

const recoverSession = Effect.fn("HostedAccount.recoverSession")(function* (profile: Profile, failed: Session) {
  const store = yield* CredentialStore
  const credential = yield* store.serialized(
    Effect.gen(function* () {
      const current = yield* store.load(profile.origin, profile.deviceId)
      if (Option.isNone(current)) return yield* failure("login-required", "Run rika auth login first")
      if (
        activeCredential(current.value, yield* Clock.currentTimeMillis) &&
        Redacted.value(current.value.accessToken) !== Redacted.value(failed.accessToken)
      )
        return current.value
      return yield* refresh(profile, current.value)
    }),
  )
  return sessionFromCredential(credential)
})

export const authenticated = Effect.fn("HostedAccount.authenticated")(function* <A>(
  profile: Profile,
  request: (session: Session) => Effect.Effect<A, HostedError>,
) {
  const session = yield* acquireSession(profile)
  const result = yield* Effect.result(request(session))
  if (result._tag === "Success") return result.success
  if (result.failure.kind !== "login-required") return yield* result.failure
  return yield* request(yield* recoverSession(profile, session))
})

const loginProfile = (
  origin: string,
  previous: Profile | undefined,
  started: { readonly deviceId: string; readonly clientId: string },
): Profile => {
  const sameOrigin = previous !== undefined && previous.origin === origin
  return {
    origin,
    deviceId: started.deviceId,
    clientId: started.clientId,
    owner: sameOrigin ? previous.owner : { kind: "personal" },
    project: sameOrigin ? previous.project : undefined,
  }
}

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
  const freshAuthorization = Effect.gen(function* () {
    const privateJwk = yield* Dpop.generate()
    const deviceId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => failure("host", "Could not identify this installation")),
    )
    const clientId = (yield* http.register(
      origin,
      deviceId,
      Dpop.publicJwk(privateJwk),
      yield* Dpop.thumbprint(Dpop.publicJwk(privateJwk)),
    )).clientId
    const authorization = yield* http.startDeviceAuthorization(origin, clientId, privateJwk)
    return { privateJwk, deviceId, clientId, authorization }
  })
  const started = yield* Option.isSome(reusable)
    ? http.startDeviceAuthorization(origin, previous!.clientId, reusable.value.privateJwk).pipe(
        Effect.map((authorization) => ({
          privateJwk: reusable.value.privateJwk,
          deviceId: previous!.deviceId,
          clientId: previous!.clientId,
          authorization,
        })),
        Effect.catch((error) => (error.kind === "registration-required" ? freshAuthorization : Effect.fail(error))),
      )
    : freshAuthorization
  const nextProfile = loginProfile(origin, previous, started)
  const issuedAt = yield* Clock.currentTimeMillis
  const verification = started.authorization.verificationUriComplete ?? started.authorization.verificationUri
  yield* Console.log(`Open ${verification}\nEnter code: ${started.authorization.userCode}`)
  if (!input.noOpen)
    yield* browser
      .open(verification)
      .pipe(Effect.catch((error) => Console.log(`${error.message}; continue with the URL above`)))
  const tokens = yield* pollDeviceAuthorization(nextProfile, started.privateJwk, started.authorization, issuedAt)
  const tokensReceivedAt = yield* Clock.currentTimeMillis
  const identity = yield* http.context(origin, sessionFrom(tokens, started.privateJwk))
  const selected = validOwner(nextProfile, identity)
    ? nextProfile
    : { ...nextProfile, owner: { kind: "personal" as const }, project: undefined }
  yield* credentials.save(origin, started.deviceId, credentialFrom(tokens, started.privateJwk, tokensReceivedAt))
  yield* profiles.save(selected)
  if (previous !== undefined && previous.origin === origin && previous.deviceId !== started.deviceId) {
    const revoked = yield* Effect.result(
      http.revokeDevice(origin, previous.deviceId, sessionFrom(tokens, started.privateJwk)),
    )
    if (Result.isFailure(revoked))
      yield* Console.log(
        `Previous CLI device ${previous.deviceId} could not be revoked: ${revoked.failure.message}\nRun rika auth revoke-device ${previous.deviceId} to revoke it`,
      )
  }
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
        project: loaded.value.project,
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
