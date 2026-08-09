import * as ServerService from "@rika/product/server-service"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import { Crypto, Effect, Encoding, FileSystem, Option, Path, Schema } from "effect"

const tokenName = "server.token"
const serverLog = /^server-.+-(\d+)\.open\.jsonl$/

export interface ServerEndpoint {
  readonly identity: string
  readonly canonicalDataRoot: string
  readonly port: number
  readonly url: string
  readonly tokenPath: string
  readonly startupPath: string
}

export const ServerPublication = Schema.Struct({
  port: Schema.Int,
  pid: Schema.Int,
  tokenPath: Schema.String,
  version: Schema.String,
  protocolVersion: Schema.Int,
})
export type ServerPublication = typeof ServerPublication.Type

export class ServerPublicationError extends Schema.TaggedErrorClass<ServerPublicationError>()(
  "ServerPublicationError",
  {
    reason: Schema.Literals(["unavailable", "invalid", "unsafe", "incompatible"]),
    message: Schema.String,
  },
) {}

export type PublishedEndpoint = {
  readonly endpoint: ServerEndpoint
  readonly token: string
  readonly publication: ServerPublication
}

const publicationName = "server.json"
const publicationMaxBytes = 16 * 1_024
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodePublication = Schema.decodeUnknownEffect(ServerPublication)
const publicationFailure = (reason: ServerPublicationError["reason"], message: string) =>
  ServerPublicationError.make({ reason, message })
const unsafeToken = () =>
  ServerService.ServerServiceError.make({
    reason: "unsafe-token",
    message: "Server credential is unsafe",
  })

export const resolve = Effect.fn("ServerEndpoint.resolve")(function* (profile: string, dataRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonicalDataRoot = yield* fs.realPath(dataRoot)
  const identity = yield* ServerService.ServiceRuntime.canonicalServiceIdentity(
    profile.trim().toLowerCase(),
    canonicalDataRoot,
  )
  const port = 20_000 + (Number.parseInt(identity.slice(0, 8), 16) % 30_000)
  return {
    identity,
    canonicalDataRoot,
    port,
    url: `ws://127.0.0.1:${port}/server`,
    tokenPath: path.join(canonicalDataRoot, tokenName),
    startupPath: path.join(canonicalDataRoot, `server-${identity}.startup`),
  } satisfies ServerEndpoint
})

export const recordedServerProcesses = Effect.fn("ServerEndpoint.recordedProcesses")(function* (endpoint: {
  readonly canonicalDataRoot: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined
  const processes = new Map<number, Array<string>>()
  const diagnostics = path.join(endpoint.canonicalDataRoot, "diagnostics")
  if (!(yield* fs.exists(diagnostics)) || (yield* Effect.result(fs.readLink(diagnostics)))._tag === "Success") return []
  const directory = yield* Effect.result(fs.stat(diagnostics))
  if (
    directory._tag === "Failure" ||
    directory.success.type !== "Directory" ||
    (expectedUid !== undefined && Option.getOrUndefined(directory.success.uid) !== expectedUid)
  )
    return []
  for (const name of yield* fs.readDirectory(diagnostics)) {
    const match = serverLog.exec(name)
    if (match === null) continue
    const filename = path.join(diagnostics, name)
    if ((yield* Effect.result(fs.readLink(filename)))._tag === "Success") continue
    const info = yield* Effect.result(fs.stat(filename))
    if (
      info._tag === "Success" &&
      info.success.type === "File" &&
      (info.success.mode & 0o077) === 0 &&
      (expectedUid === undefined || Option.getOrUndefined(info.success.uid) === expectedUid)
    ) {
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      const markers = processes.get(pid) ?? []
      markers.push(filename)
      processes.set(pid, markers)
    }
  }
  return [...processes].map(([pid, markers]) => ({ pid, markers }))
})

export const readToken = Effect.fn("ServerEndpoint.readToken")(function* (tokenPath: string) {
  const fs = yield* FileSystem.FileSystem
  const readLinkBefore = yield* Effect.result(fs.readLink(tokenPath))
  if (readLinkBefore._tag === "Success") return yield* unsafeToken()

  const before = yield* fs.stat(tokenPath).pipe(Effect.mapError(unsafeToken))
  const token = (yield* fs.readFileString(tokenPath).pipe(Effect.mapError(unsafeToken))).trim()
  const after = yield* fs.stat(tokenPath).pipe(Effect.mapError(unsafeToken))
  const readLinkAfter = yield* Effect.result(fs.readLink(tokenPath))
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined
  const beforeUid = Option.getOrUndefined(before.uid)
  const afterUid = Option.getOrUndefined(after.uid)
  const beforeIno = Option.getOrUndefined(before.ino)
  const afterIno = Option.getOrUndefined(after.ino)
  if (
    readLinkAfter._tag === "Success" ||
    before.type !== "File" ||
    after.type !== "File" ||
    (before.mode & 0o777) !== 0o600 ||
    (after.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && (beforeUid !== expectedUid || afterUid !== expectedUid)) ||
    before.dev !== after.dev ||
    beforeIno === undefined ||
    afterIno === undefined ||
    beforeIno !== afterIno ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return yield* unsafeToken()
  }
  return token
})

export const readOrCreateToken = Effect.fn("ServerEndpoint.readOrCreateToken")(function* (tokenPath: string) {
  const fs = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const generated = Encoding.encodeHex(yield* crypto.randomBytes(32))
  const created = yield* Effect.result(fs.writeFileString(tokenPath, `${generated}\n`, { flag: "wx", mode: 0o600 }))
  if (created._tag === "Failure" && !(yield* fs.exists(tokenPath))) {
    return yield* ServerService.ServerServiceError.make({
      reason: "unsafe-token",
      message: "Server credential could not be created",
    })
  }
  return yield* readToken(tokenPath)
})

export const readPublished = Effect.fn("ServerEndpoint.readPublished")(function* (input: {
  readonly profile: string
  readonly dataRoot: string
}) {
  const endpoint = yield* resolve(input.profile, input.dataRoot).pipe(
    Effect.mapError(() => publicationFailure("unavailable", "Server publication is unavailable")),
  )
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const publicationPath = path.join(endpoint.canonicalDataRoot, publicationName)
  const readLinkBefore = yield* Effect.result(fs.readLink(publicationPath))
  if (readLinkBefore._tag === "Success") {
    return yield* publicationFailure("unsafe", "Server publication is unsafe")
  }

  const before = yield* fs
    .stat(publicationPath)
    .pipe(Effect.mapError(() => publicationFailure("unavailable", "Server publication is unavailable")))
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined
  const beforeUid = Option.getOrUndefined(before.uid)
  if (
    before.type !== "File" ||
    (before.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && beforeUid !== expectedUid) ||
    before.size > BigInt(publicationMaxBytes)
  ) {
    return yield* publicationFailure("unsafe", "Server publication is unsafe")
  }

  const text = yield* fs
    .readFileString(publicationPath)
    .pipe(Effect.mapError(() => publicationFailure("unavailable", "Server publication is unavailable")))
  const after = yield* fs
    .stat(publicationPath)
    .pipe(Effect.mapError(() => publicationFailure("unsafe", "Server publication is unsafe")))
  const readLinkAfter = yield* Effect.result(fs.readLink(publicationPath))
  const afterUid = Option.getOrUndefined(after.uid)
  const beforeIno = Option.getOrUndefined(before.ino)
  const afterIno = Option.getOrUndefined(after.ino)
  if (
    readLinkAfter._tag === "Success" ||
    after.type !== "File" ||
    (after.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && afterUid !== expectedUid) ||
    after.size > BigInt(publicationMaxBytes) ||
    before.dev !== after.dev ||
    beforeIno === undefined ||
    afterIno === undefined ||
    beforeIno !== afterIno
  ) {
    return yield* publicationFailure("unsafe", "Server publication is unsafe")
  }

  const json = yield* decodeJson(text).pipe(
    Effect.mapError(() => publicationFailure("invalid", "Server publication is invalid")),
  )
  const publication = yield* decodePublication(json).pipe(
    Effect.mapError(() => publicationFailure("invalid", "Server publication is invalid")),
  )
  if (publication.protocolVersion !== ServerHandshake.HandshakeProtocol.protocolVersion) {
    return yield* publicationFailure("incompatible", "Server publication is incompatible")
  }
  if (
    !Number.isSafeInteger(publication.pid) ||
    publication.pid <= 0 ||
    !Number.isSafeInteger(publication.port) ||
    publication.port <= 0 ||
    publication.port > 65_535 ||
    publication.version.trim().length === 0 ||
    publication.version.length > 1_024 ||
    publication.port !== endpoint.port ||
    publication.tokenPath !== endpoint.tokenPath
  ) {
    return yield* publicationFailure("invalid", "Server publication is invalid")
  }

  const token = yield* readToken(endpoint.tokenPath)
  return { endpoint, token, publication } satisfies PublishedEndpoint
})
