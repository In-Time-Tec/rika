/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- DPoP claims omit ath when no access token is bound. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- Effect's dynamic function builder widens the captured runtime context. */
/* oxlint-disable effecttsgo/any-unknown-in-error-context -- generic schema decoding is contained at the credential file boundary. */
/* oxlint-disable effecttsgo/crypto-random-uuid-in-effect -- DPoP jti uses the platform Web Crypto UUID primitive. */
/* oxlint-disable effecttsgo/nested-effect-gen-yield -- refresh is kept as one scoped credential transaction. */
/* oxlint-disable effecttsgo/prefer-schema-over-json -- compact JOSE segments require canonical JSON bytes before base64url encoding. */
/* oxlint-disable effecttsgo/process-env-in-effect -- HOME is a process launch setting for the filesystem adapter. */
/* oxlint-disable effecttsgo/strict-boolean-expressions -- URL fields are validated as non-empty strings at this boundary. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- access token narrowing crosses the schema union boundary. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Schema's generic decoder reports unknown requirements despite this service-only effect. */
/* oxlint-disable effecttsgo/unsafe-effect-type-assertion -- Schema's generic decoder reports unknown requirements despite this service-only effect. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the adapter narrows Schema's generic requirements to its explicit service boundary. */
import { Clock, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect"
import { Buffer } from "node:buffer"
import type { GeneralistTransportAuth } from "./generalist"

const PublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
})
const PrivateJwk = Schema.Struct({ ...PublicJwk.fields, d: Schema.String })
type PrivateJwk = typeof PrivateJwk.Type

const ProfileDisk = Schema.Struct({
  formatVersion: Schema.Literal(3),
  origin: Schema.String,
  deviceId: Schema.String,
  clientId: Schema.String,
})
const CredentialDiskV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  origin: Schema.String,
  deviceId: Schema.String,
  refreshToken: Schema.String,
  privateJwk: PrivateJwk,
})
const CredentialDiskV2 = Schema.Struct({
  formatVersion: Schema.Literal(2),
  origin: Schema.String,
  deviceId: Schema.String,
  refreshToken: Schema.String,
  privateJwk: PrivateJwk,
  accessToken: Schema.String,
  accessTokenExpiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
})
const CredentialDisk = Schema.Union([CredentialDiskV1, CredentialDiskV2])
const TokenWire = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Int,
  token_type: Schema.String,
})

export class HostedCredentialError extends Schema.TaggedError<HostedCredentialError>()("RikaClientV2CredentialError", {
  kind: Schema.Literals(["login-required", "storage", "network", "protocol"]),
  message: Schema.String,
}) {}

export interface FileCredentialAuthOptions {
  readonly origin: string
  // ast-grep-ignore: effect-prefer-effect-signatures -- callers provide the platform Web Fetch boundary.
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly home?: string
  readonly httpAuthorizationScheme?: "Bearer" | "DPoP"
  readonly webSocketAuthorizationScheme?: "Bearer" | "DPoP"
}

const failure = (kind: HostedCredentialError["kind"], message: string) => HostedCredentialError.make({ kind, message })
const encoded = (value: string | Uint8Array) => Buffer.from(value).toString("base64url")
const publicJwk = (key: PrivateJwk) => ({ kty: key.kty, crv: key.crv, x: key.x, y: key.y })
const dpopUrl = (url: string): Effect.Effect<string, HostedCredentialError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(url)
      if (parsed.protocol === "ws:") parsed.protocol = "http:"
      else if (parsed.protocol === "wss:") parsed.protocol = "https:"
      return `${parsed.origin}${parsed.pathname}`
    },
    catch: () => failure("protocol", "Could not normalize the DPoP request URL"),
  })
const dpopProof = (input: {
  readonly method: string
  readonly url: string
  readonly privateJwk: PrivateJwk
  readonly accessToken?: string
  readonly clock: Clock.Clock
}): Effect.Effect<string, HostedCredentialError> => Effect.gen(function* () {
  const now = yield* input.clock.currentTimeMillis
  const url = yield* dpopUrl(input.url)
  const header = encoded(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk(input.privateJwk) }))
  const ath =
    input.accessToken === undefined
      ? undefined
      : yield* Effect.tryPromise({
          try: () => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.accessToken)),
          catch: () => failure("protocol", "Could not bind the DPoP proof to the access token"),
        }).pipe(Effect.map((hash) => encoded(new Uint8Array(hash))))
  const payloadValue = {
    htu: url,
    htm: input.method.toUpperCase(),
    iat: Math.floor(now / 1_000),
    jti: globalThis.crypto.randomUUID(),
    ...(ath === undefined ? {} : { ath }),
  }
  const payload = encoded(JSON.stringify(payloadValue))
  const signingInput = `${header}.${payload}`
  const key = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.importKey("jwk", input.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    catch: () => failure("protocol", "Could not import the installation DPoP key"),
  })
  const signature = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)),
    catch: () => failure("protocol", "Could not create a DPoP proof"),
  })
  return `${signingInput}.${encoded(new Uint8Array(signature))}`
})

const originFor = (origin: string): Effect.Effect<string, HostedCredentialError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(origin)
      if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash)
        throw new Error("invalid origin")
      return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")}`
    },
    catch: () => failure("protocol", "Hosted API origin is invalid"),
  })

let writeSequence = 0

const privateDirectory = (input: {
  readonly fileSystem: FileSystem.FileSystem
  readonly parent: string
  readonly expectedUid: number | undefined
  readonly create: boolean
}): Effect.Effect<boolean, HostedCredentialError> => Effect.gen(function* () {
  const exists = yield* input.fileSystem
    .exists(input.parent)
    .pipe(Effect.mapError(() => failure("storage", "Hosted credentials could not be inspected")))
  if (!exists) {
    if (!input.create) return false
    yield* input.fileSystem
      .makeDirectory(input.parent, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => failure("storage", "Hosted credential directory could not be created")))
  }
  if ((yield* Effect.result(input.fileSystem.readLink(input.parent)))._tag === "Success")
    return yield* failure("storage", "Hosted credential directory cannot be a symbolic link")
  const info = yield* input.fileSystem
    .stat(input.parent)
    .pipe(Effect.mapError(() => failure("storage", "Hosted credentials could not be inspected")))
  if (info.type !== "Directory" || (input.expectedUid !== undefined && Option.getOrUndefined(info.uid) !== input.expectedUid))
    return yield* failure("storage", "Hosted credential directory is not owned by this user")
  if ((info.mode & 0o077) !== 0) {
    if (!input.create) return yield* failure("storage", "Hosted credential directory permissions must be private")
    yield* input.fileSystem
      .chmod(input.parent, 0o700)
      .pipe(Effect.mapError(() => failure("storage", "Hosted credential directory could not be secured")))
  }
  return true
})

const privateFile = (input: {
  readonly fileSystem: FileSystem.FileSystem
  readonly filename: string
  readonly expectedUid: number | undefined
}): Effect.Effect<void, HostedCredentialError> => Effect.gen(function* () {
  const linked = yield* Effect.result(input.fileSystem.readLink(input.filename))
  if (linked._tag === "Success") return yield* failure("storage", "Hosted credential files cannot be symbolic links")
  const info = yield* input.fileSystem
    .stat(input.filename)
    .pipe(Effect.mapError(() => failure("storage", "Hosted credentials could not be inspected")))
  if (info.type !== "File" || (input.expectedUid !== undefined && Option.getOrUndefined(info.uid) !== input.expectedUid))
    return yield* failure("storage", "Hosted credential file is not owned by this user")
  if ((info.mode & 0o777) !== 0o600) return yield* failure("storage", "Hosted credential file permissions must be 0600")
})

const readPrivateText = (input: {
  readonly fileSystem: FileSystem.FileSystem
  readonly filename: string
  readonly parent: string
  readonly expectedUid: number | undefined
  readonly missing: HostedCredentialError
}): Effect.Effect<string, HostedCredentialError> => Effect.gen(function* () {
  const exists = yield* input.fileSystem
    .exists(input.filename)
    .pipe(Effect.mapError(() => failure("storage", "Hosted credentials could not be inspected")))
  if (!exists) return yield* input.missing
  if (!(yield* privateDirectory({ fileSystem: input.fileSystem, parent: input.parent, expectedUid: input.expectedUid, create: false })))
    return yield* input.missing
  yield* privateFile({ fileSystem: input.fileSystem, filename: input.filename, expectedUid: input.expectedUid })
  const text = yield* input.fileSystem
    .readFileString(input.filename)
    .pipe(Effect.mapError(() => failure("storage", "Hosted credentials could not be read")))
  return text
})

const readProfile = (input: Parameters<typeof readPrivateText>[0]) =>
  readPrivateText(input).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(ProfileDisk))(text)),
    Effect.mapError(() => failure("storage", "Hosted credentials are corrupt")),
  )

const readCredentialFile = (input: Parameters<typeof readPrivateText>[0]) =>
  readPrivateText(input).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(CredentialDisk))(text)),
    Effect.mapError(() => failure("storage", "Hosted credentials are corrupt")),
  )

const saveCredential = (input: {
  readonly fileSystem: FileSystem.FileSystem
  readonly filename: string
  readonly parent: string
  readonly expectedUid: number | undefined
  readonly origin: string
  readonly deviceId: string
  readonly refreshToken: string
  readonly privateJwk: PrivateJwk
  readonly accessToken: string
  readonly accessTokenExpiresAt: number
}): Effect.Effect<void, HostedCredentialError> => Effect.gen(function* () {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(CredentialDiskV2))({
    formatVersion: 2,
    origin: input.origin,
    deviceId: input.deviceId,
    refreshToken: input.refreshToken,
    privateJwk: input.privateJwk,
    accessToken: input.accessToken,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
  }).pipe(
    Effect.mapError(() => failure("storage", "Hosted credentials could not be encoded")),
  )
  if (!(yield* privateDirectory({ fileSystem: input.fileSystem, parent: input.parent, expectedUid: input.expectedUid, create: true })))
    return yield* failure("storage", "Hosted credential directory could not be created")
  const exists = yield* input.fileSystem
    .exists(input.filename)
    .pipe(Effect.mapError(() => failure("storage", "Hosted credentials could not be inspected")))
  if (exists) yield* privateFile({ fileSystem: input.fileSystem, filename: input.filename, expectedUid: input.expectedUid })
  writeSequence += 1
  const temporary = `${input.filename}.tmp-${process.pid}-${writeSequence}`
  yield* input.fileSystem
    .writeFileString(temporary, text, { flag: "wx", mode: 0o600 })
    .pipe(
      Effect.andThen(input.fileSystem.chmod(temporary, 0o600)),
      Effect.andThen(input.fileSystem.rename(temporary, input.filename)),
      Effect.ensuring(input.fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(() => failure("storage", "Hosted credentials could not be saved")),
    )
})

export const makeFileCredentialAuth = (
  options: FileCredentialAuthOptions,
): Effect.Effect<GeneralistTransportAuth, HostedCredentialError, FileSystem.FileSystem | Path.Path> => {
  const program: Effect.Effect<GeneralistTransportAuth, HostedCredentialError, FileSystem.FileSystem | Path.Path> = Effect.gen(function* () {
    const origin = yield* originFor(options.origin)
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const clock = yield* Clock.Clock
    const fetch = options.fetch
    // ast-grep-ignore: effect-prefer-config -- HOME is an outer process launch setting for this filesystem adapter.
    const home = options.home ?? process.env.HOME ?? process.cwd()
    const profileFilename = path.join(home, ".config", "rika", "hosted.json")
    const credentialFilename = path.join(home, ".config", "rika", "hosted-credential.json")
    const profileParent = path.dirname(profileFilename)
    const credentialParent = path.dirname(credentialFilename)
    const expectedUid = process.getuid?.()
    const profile = yield* readProfile({
      fileSystem,
      filename: profileFilename,
      parent: profileParent,
      expectedUid,
      missing: failure("login-required", "Run rika auth login first"),
    })
    if (profile.origin !== origin) return yield* failure("login-required", "No hosted credentials exist for this API origin")
    const refreshLock = yield* Semaphore.make(1)
    const readCredential = () => Effect.gen(function* () {
      const stored = yield* readCredentialFile({
        fileSystem,
        filename: credentialFilename,
        parent: credentialParent,
        expectedUid,
        missing: failure("login-required", "Run rika auth login first"),
      })
      if (stored.origin !== origin || stored.deviceId !== profile.deviceId)
        return yield* failure("login-required", "No hosted credentials exist for this CLI device")
      return stored
    })
    const activeCredential = (stored: typeof CredentialDisk.Type, now: number) =>
      "accessToken" in stored && stored.accessTokenExpiresAt > now + 30_000 ? stored : undefined
    const refreshCredential = (stored: typeof CredentialDisk.Type) => Effect.gen(function* () {
      const url = `${origin}/api/auth/oauth2/token`
      const proof = yield* dpopProof({ method: "POST", url, privateJwk: stored.privateJwk, clock })
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: profile.clientId,
        resource: `${origin}/api/v1`,
      })
      const response = yield* Effect.tryPromise({
        try: () =>
          // ast-grep-ignore: effect-prefer-http -- callers provide the platform Web Fetch boundary.
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
            body,
          }),
        catch: () => failure("network", "Hosted token refresh failed"),
      })
      if (!response.ok)
        return yield* failure(response.status === 401 ? "login-required" : "network", "Hosted token refresh was rejected")
      const wire = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failure("protocol", "Hosted token response was invalid"),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TokenWire)),
        Effect.mapError(() => failure("protocol", "Hosted token response was invalid")),
      )
      if (wire.expires_in <= 0 || wire.token_type.toLowerCase() !== "dpop")
        return yield* failure("protocol", "Hosted token response was not a valid DPoP response")
      const receivedAt = yield* clock.currentTimeMillis
      const value = {
        origin,
        deviceId: profile.deviceId,
        parent: credentialParent,
        refreshToken: wire.refresh_token ?? stored.refreshToken,
        privateJwk: stored.privateJwk,
        accessToken: wire.access_token,
        accessTokenExpiresAt: receivedAt + wire.expires_in * 1_000,
      }
      yield* saveCredential({ fileSystem, filename: credentialFilename, expectedUid, ...value })
      return value
    })
    const resolveCredential = () => Effect.gen(function* () {
      const stored = yield* readCredential()
      const now = yield* clock.currentTimeMillis
      const active = activeCredential(stored, now)
      if (active !== undefined) return active
      return yield* refreshLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readCredential()
          const currentNow = yield* clock.currentTimeMillis
          const currentActive = activeCredential(current, currentNow)
          return currentActive ?? (yield* refreshCredential(current))
        }),
      )
    })
    const scheme = options.httpAuthorizationScheme ?? "DPoP"
    const wsScheme = options.webSocketAuthorizationScheme ?? "DPoP"
    const headersFor = (input: { readonly method: string; readonly url: string }, authorizationScheme: string) =>
      Effect.gen(function* () {
        const credential = yield* resolveCredential()
        const proof = yield* dpopProof({
          method: input.method,
          url: input.url,
          privateJwk: credential.privateJwk,
          accessToken: credential.accessToken,
          clock,
        })
        return { authorization: `${authorizationScheme} ${credential.accessToken}`, dpop: proof }
      }).pipe(Effect.orDie)
    const auth: GeneralistTransportAuth = {
      requestHeaders: (input) => headersFor(input, scheme),
      webSocketHeaders: (input) => headersFor(input, wsScheme),
    }
    return auth
  })
  return program
}
