import { Clock, Crypto, Effect, FileSystem, PlatformError, Schema } from "effect"
import * as ServerService from "@rika/product/server-service"

const StartupLease = Schema.Struct({
  identity: Schema.String,
  nonce: Schema.String,
  ownerPid: Schema.Int,
  processPid: Schema.Int,
  claimedAt: Schema.Finite,
  expiresAt: Schema.Finite,
})

const decodeLease = Schema.decodeUnknownEffect(Schema.fromJsonString(StartupLease))
const encodeLease = Schema.encodeSync(Schema.UnknownFromJsonString)

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const failure = (cause: unknown) =>
  ServerService.ServerServiceError.make({
    reason: "transport-failed",
    message: `Server startup coordination failed: ${String(cause)}`,
  })

const removeIfUnchanged = (fs: FileSystem.FileSystem, path: string, expected: string) =>
  fs.readFileString(path).pipe(
    Effect.flatMap((current) => (current === expected ? fs.remove(path) : Effect.void)),
    Effect.ignore,
  )

export type StartupClaim =
  | {
      readonly _tag: "Owner"
      readonly adopt: (pid: number) => Effect.Effect<void, ServerService.ServerServiceError>
      readonly release: Effect.Effect<void>
    }
  | { readonly _tag: "Joiner" }

export const claimStartup = Effect.fn("ServerStartup.claim")(function* (
  path: string,
  identity: string,
  deadline?: number,
): Effect.fn.Return<StartupClaim, ServerService.ServerServiceError, FileSystem.FileSystem | Crypto.Crypto> {
  const fs = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const expires = deadline ?? (yield* Clock.currentTimeMillis) + 30_000
  while (true) {
    const claimedAt = yield* Clock.currentTimeMillis
    if (claimedAt >= expires) return yield* failure("Server startup coordination exceeded its deadline")
    const lease = {
      identity,
      nonce: yield* crypto.randomUUIDv4.pipe(Effect.mapError(failure)),
      ownerPid: process.pid,
      processPid: process.pid,
      claimedAt,
      expiresAt: claimedAt + 30_000,
    }
    const encoded = encodeLease(lease)
    const created = yield* Effect.result(fs.writeFileString(path, encoded, { flag: "wx", mode: 0o600 }))
    if (created._tag === "Success") {
      yield* Effect.logInfo("server.startup.claimed").pipe(
        Effect.annotateLogs({ "rika.server.startup.role": "owner", "rika.server.startup.pid": process.pid }),
      )
      let owned = encoded
      const adopt = Effect.fn("ServerStartup.adopt")(function* (pid: number) {
        const current = yield* fs.readFileString(path).pipe(Effect.mapError(failure))
        if (current !== owned) return yield* failure("Server startup ownership changed before child adoption")
        const adopted = encodeLease({ ...lease, processPid: pid, expiresAt: (yield* Clock.currentTimeMillis) + 30_000 })
        const temporaryPath = `${path}.${lease.nonce}.tmp`
        yield* fs.writeFileString(temporaryPath, adopted, { flag: "wx", mode: 0o600 }).pipe(Effect.mapError(failure))
        yield* fs
          .rename(temporaryPath, path)
          .pipe(Effect.mapError(failure), Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.ignore)))
        owned = adopted
        yield* Effect.logInfo("server.startup.adopted").pipe(
          Effect.annotateLogs({ "rika.server.startup.role": "child", "rika.server.startup.pid": pid }),
        )
      })
      return {
        _tag: "Owner",
        adopt,
        release: Effect.suspend(() =>
          removeIfUnchanged(fs, path, owned).pipe(Effect.andThen(Effect.logInfo("server.startup.released"))),
        ),
      }
    }
    const read = yield* Effect.result(fs.readFileString(path))
    if (read._tag === "Failure") {
      if (read.failure.reason instanceof PlatformError.SystemError && read.failure.reason._tag === "NotFound") continue
      return yield* failure(read.failure)
    }
    const existingText = read.success
    const existing = yield* Effect.result(decodeLease(existingText))
    if (
      existing._tag === "Success" &&
      existing.success.identity === identity &&
      processIsAlive(existing.success.processPid)
    ) {
      const now = yield* Clock.currentTimeMillis
      if (now > existing.success.expiresAt) {
        yield* Effect.logError("server.startup.stalled").pipe(
          Effect.annotateLogs({
            "rika.server.startup.pid": existing.success.processPid,
            "rika.duration.ms": now - existing.success.claimedAt,
          }),
        )
        return yield* failure(`Server process ${existing.success.processPid} is alive but startup expired`)
      }
      yield* Effect.logDebug("server.startup.waiting").pipe(
        Effect.annotateLogs({ "rika.server.startup.pid": existing.success.processPid }),
      )
      return { _tag: "Joiner" }
    }
    yield* removeIfUnchanged(fs, path, existingText)
    yield* Effect.logWarning("server.startup.reclaimed").pipe(
      Effect.annotateLogs({
        "rika.server.startup.role": "reclaimer",
        ...(existing._tag === "Success" ? { "rika.server.startup.pid": existing.success.processPid } : {}),
      }),
    )
  }
})

export const releaseAdoptedStartup = Effect.fn("ServerStartup.releaseAdopted")(function* (
  path: string,
  identity: string,
  pid: number,
) {
  const fs = yield* FileSystem.FileSystem
  const read = yield* Effect.result(fs.readFileString(path))
  if (read._tag === "Failure") return
  const lease = yield* Effect.result(decodeLease(read.success))
  if (lease._tag === "Failure" || lease.success.identity !== identity || lease.success.processPid !== pid) return
  yield* removeIfUnchanged(fs, path, read.success).pipe(Effect.andThen(Effect.logInfo("server.startup.released")))
})
