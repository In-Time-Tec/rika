import { ResidentService } from "@rika/app"
import { Crypto, Effect, Encoding, FileSystem, Option, Path } from "effect"

const tokenName = "resident.token"

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
    url: `ws://127.0.0.1:${port}/resident/v1`,
    tokenPath: path.join(canonicalDataRoot, tokenName),
  }
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
