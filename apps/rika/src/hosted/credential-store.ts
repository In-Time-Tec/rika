import { Clock, Effect, FileSystem, Layer, Option, Path, PlatformError, Redacted, Schema, Semaphore } from "effect"
import { CredentialStore, HostedError, PrivateJwk, type ActiveCredential, type Credential } from "./contract"

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
const RefreshLockDisk = Schema.Struct({ pid: Schema.Int })

const failure = (message: string) => HostedError.make({ kind: "storage", message })
const ErrorCode = Schema.Struct({ code: Schema.String })
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCode)
const errorCode = (cause: unknown) => Option.getOrUndefined(decodeErrorCode(cause))?.code
type RefreshLock = FileSystem.File.Info

export const layer = (options: {
  readonly filename: string
  readonly lockPath: string
  readonly lockTimeout?: number
  readonly lockRetry?: number
}) =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const admission = yield* Semaphore.make(1)
      const parent = path.dirname(options.filename)
      const expectedUid = process.getuid?.()
      let writeSequence = 0
      const storageFailure = (operation: string) => failure(`Credential file could not be ${operation}`)
      const directoryReady = Effect.fn("HostedCredentialStore.directoryReady")(function* (create: boolean) {
        const exists = yield* fileSystem.exists(parent).pipe(Effect.mapError(() => storageFailure("inspected")))
        if (!exists) {
          if (!create) return false
          yield* fileSystem
            .makeDirectory(parent, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError(() => storageFailure("created")))
        }
        if ((yield* Effect.result(fileSystem.readLink(parent)))._tag === "Success")
          return yield* failure("Credential directory cannot be a symbolic link")
        const info = yield* fileSystem.stat(parent).pipe(Effect.mapError(() => storageFailure("inspected")))
        if (info.type !== "Directory" || (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid))
          return yield* failure("Credential directory is not owned by this user")
        if (create && (info.mode & 0o077) !== 0)
          yield* fileSystem.chmod(parent, 0o700).pipe(Effect.mapError(() => storageFailure("secured")))
        else if ((info.mode & 0o077) !== 0)
          return yield* failure("Credential directory permissions must not allow group or other access")
        return true
      })
      const filePresent = Effect.fn("HostedCredentialStore.filePresent")(function* () {
        const exists = yield* fileSystem
          .exists(options.filename)
          .pipe(Effect.mapError(() => storageFailure("inspected")))
        if (!exists) return false
        if (!(yield* directoryReady(false))) return false
        if ((yield* Effect.result(fileSystem.readLink(options.filename)))._tag === "Success")
          return yield* failure("Credential file cannot be a symbolic link")
        const info = yield* fileSystem.stat(options.filename).pipe(Effect.mapError(() => storageFailure("inspected")))
        if (info.type !== "File" || (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid))
          return yield* failure("Credential file is not owned by this user")
        if ((info.mode & 0o777) !== 0o600) return yield* failure("Credential file permissions must be 0600")
        return true
      })
      const read = Effect.fn("HostedCredentialStore.read")(function* () {
        if (!(yield* filePresent())) return Option.none<typeof CredentialDisk.Type>()
        const text = yield* fileSystem
          .readFileString(options.filename)
          .pipe(Effect.mapError(() => storageFailure("read")))
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(CredentialDisk))(text).pipe(
          Effect.mapError(() => failure("Credentials are corrupt")),
        )
        return Option.some(decoded)
      })
      const sameFile = (left: RefreshLock, right: RefreshLock) =>
        left.dev === right.dev && Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino)
      const removeAbandonedLock = Effect.gen(function* () {
        const observed = yield* fileSystem.stat(options.lockPath).pipe(Effect.option)
        if (Option.isNone(observed)) return false
        const text = yield* fileSystem.readFileString(options.lockPath).pipe(Effect.option)
        if (Option.isNone(text)) return false
        const value = yield* Schema.decodeEffect(Schema.fromJsonString(RefreshLockDisk))(text.value).pipe(Effect.option)
        if (Option.isNone(value)) return false
        const alive = yield* Effect.sync(() => {
          try {
            process.kill(value.value.pid, 0)
            return true
          } catch (cause) {
            return errorCode(cause) !== "ESRCH"
          }
        })
        if (alive) return false
        const current = yield* fileSystem.stat(options.lockPath).pipe(Effect.option)
        if (Option.isNone(current) || !sameFile(observed.value, current.value)) return false
        return yield* fileSystem.remove(options.lockPath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      })
      const acquireLock = Effect.gen(function* () {
        yield* directoryReady(true)
        const lockText = yield* Schema.encodeEffect(Schema.fromJsonString(RefreshLockDisk))({
          pid: process.pid,
        }).pipe(Effect.mapError(() => failure("Credential refresh lock is unavailable")))
        const deadline = (yield* Clock.currentTimeMillis) + (options.lockTimeout ?? 30_000)
        while (true) {
          const written = yield* Effect.result(
            fileSystem.writeFileString(options.lockPath, lockText, { flag: "wx", mode: 0o600 }),
          )
          if (written._tag === "Success") {
            return yield* fileSystem
              .stat(options.lockPath)
              .pipe(Effect.mapError(() => failure("Credential refresh lock is unavailable")))
          }
          if (
            !(written.failure.reason instanceof PlatformError.SystemError) ||
            written.failure.reason._tag !== "AlreadyExists"
          )
            return yield* failure("Credential refresh lock is unavailable")
          yield* removeAbandonedLock
          if ((yield* Clock.currentTimeMillis) >= deadline)
            return yield* failure("Credential refresh lock timed out")
          yield* Effect.sleep(options.lockRetry ?? 50)
        }
      })
      const releaseLock = (lock: RefreshLock) =>
        Effect.gen(function* () {
          const current = yield* fileSystem.stat(options.lockPath).pipe(Effect.option)
          if (Option.isSome(current) && sameFile(current.value, lock))
            yield* fileSystem.remove(options.lockPath).pipe(Effect.ignore)
        })
      const load = Effect.fn("HostedCredentialStore.load")(function* (origin: string, deviceId: string) {
        const stored = yield* read()
        if (Option.isNone(stored) || stored.value.origin !== origin || stored.value.deviceId !== deviceId)
          return Option.none<Credential>()
        const credential: Credential = {
          refreshToken: Redacted.make(stored.value.refreshToken),
          privateJwk: stored.value.privateJwk,
        }
        return Option.some(
          stored.value.formatVersion === 1
            ? credential
            : {
                ...credential,
                accessToken: Redacted.make(stored.value.accessToken),
                accessTokenExpiresAt: stored.value.accessTokenExpiresAt,
              },
        )
      })
      const save = Effect.fn("HostedCredentialStore.save")(function* (
        origin: string,
        deviceId: string,
        credential: ActiveCredential,
      ) {
        yield* directoryReady(true)
        yield* filePresent()
        const value = yield* Schema.encodeEffect(Schema.fromJsonString(CredentialDiskV2))({
          formatVersion: 2,
          origin,
          deviceId,
          refreshToken: Redacted.value(credential.refreshToken),
          privateJwk: credential.privateJwk,
          accessToken: Redacted.value(credential.accessToken),
          accessTokenExpiresAt: credential.accessTokenExpiresAt,
        }).pipe(Effect.mapError(() => failure("Credentials could not be encoded")))
        writeSequence += 1
        const temporary = `${options.filename}.tmp-${process.pid}-${writeSequence}`
        yield* fileSystem.writeFileString(temporary, value, { flag: "wx", mode: 0o600 }).pipe(
          Effect.andThen(fileSystem.chmod(temporary, 0o600)),
          Effect.andThen(fileSystem.rename(temporary, options.filename)),
          Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(() => storageFailure("saved")),
        )
      })
      const remove = Effect.fn("HostedCredentialStore.remove")(function* (origin: string, deviceId: string) {
        const stored = yield* read()
        if (Option.isNone(stored) || stored.value.origin !== origin || stored.value.deviceId !== deviceId) return false
        yield* fileSystem.remove(options.filename).pipe(Effect.mapError(() => storageFailure("removed")))
        return true
      })
      const serialized: CredentialStore["Service"]["serialized"] = (effect) =>
        admission.withPermits(1)(Effect.acquireUseRelease(acquireLock, () => effect, releaseLock))
      return CredentialStore.of({ load, save, remove, serialized })
    }),
  )
