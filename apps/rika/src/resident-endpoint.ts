import * as ResidentService from "@rika/app/resident-service"
import { Crypto, Effect, Encoding, FileSystem, Option, Path } from "effect"

const tokenName = "resident.token"
const residentLog = /^resident-.+-(\d+)\.open\.jsonl$/

export const resolve = Effect.fn("ResidentEndpoint.resolve")(function* (profile: string, dataRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonicalDataRoot = yield* fs.realPath(dataRoot)
  const identity = yield* ResidentService.canonicalServiceIdentity(profile.trim().toLowerCase(), canonicalDataRoot)
  const port = 20_000 + (Number.parseInt(identity.slice(0, 8), 16) % 30_000)
  return {
    identity,
    canonicalDataRoot,
    port,
    url: `ws://127.0.0.1:${port}/resident`,
    legacyUrl: `ws://127.0.0.1:${port}/resident/v1`,
    tokenPath: path.join(canonicalDataRoot, tokenName),
    startupPath: path.join(canonicalDataRoot, `resident-${identity}.startup`),
  }
})

export const recordedResidentProcesses = Effect.fn("ResidentEndpoint.recordedProcesses")(function* (endpoint: {
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
    const match = residentLog.exec(name)
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

export const readOrCreateToken = Effect.fn("ResidentEndpoint.readOrCreateToken")(function* (tokenPath: string) {
  const fs = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const generated = Encoding.encodeHex(yield* crypto.randomBytes(32))
  const created = yield* Effect.result(fs.writeFileString(tokenPath, `${generated}\n`, { flag: "wx", mode: 0o600 }))
  if (created._tag === "Failure" && !(yield* fs.exists(tokenPath))) {
    return yield* ResidentService.ResidentServiceError.make({
      reason: "unsafe-token",
      message: "Resident credential could not be created",
    })
  }
  if ((yield* Effect.result(fs.readLink(tokenPath)))._tag === "Success")
    return yield* ResidentService.ResidentServiceError.make({
      reason: "unsafe-token",
      message: "Resident credential is unsafe",
    })
  const before = yield* fs.stat(tokenPath)
  const token = (yield* fs.readFileString(tokenPath)).trim()
  const after = yield* fs.stat(tokenPath)
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined
  const ownerUid = Option.getOrUndefined(before.uid)
  const beforeIno = Option.getOrUndefined(before.ino)
  const afterIno = Option.getOrUndefined(after.ino)
  if (
    before.type !== "File" ||
    after.type !== "File" ||
    (before.mode & 0o077) !== 0 ||
    (after.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && ownerUid !== expectedUid) ||
    before.dev !== after.dev ||
    beforeIno === undefined ||
    afterIno === undefined ||
    beforeIno !== afterIno ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return yield* ResidentService.ResidentServiceError.make({
      reason: "unsafe-token",
      message: "Resident credential is unsafe",
    })
  }
  return token
})
