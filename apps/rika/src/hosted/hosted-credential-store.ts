import { Clock, Effect, FileSystem, Layer, Option, Path, PlatformError, Redacted, Schema, Semaphore } from "effect"
import { CredentialStore, HostedError, PrivateJwk, type Credential } from "./hosted-contract"

const service = "com.rika.cli"
const CredentialDisk = Schema.Struct({
  formatVersion: Schema.Literal(1),
  refreshToken: Schema.String,
  privateJwk: PrivateJwk,
})
const RefreshLockDisk = Schema.Struct({ pid: Schema.Int })

export interface SecretVault {
  readonly get: (options: { readonly service: string; readonly name: string }) => Promise<string | null>
  readonly set: (options: { readonly service: string; readonly name: string; readonly value: string }) => Promise<void>
  readonly delete: (options: { readonly service: string; readonly name: string }) => Promise<boolean>
}

const liveVault = (Bun as unknown as { readonly secrets: SecretVault }).secrets
const name = (origin: string, deviceId: string) => `${new URL(origin).origin}/${deviceId}`
const failure = (message: string) => HostedError.make({ kind: "storage", message })
const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined
type RefreshLock = FileSystem.File.Info

export const layer = (options: {
  readonly lockPath: string
  readonly vault?: SecretVault
  readonly lockTimeout?: number
  readonly lockRetry?: number
}) =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const vault = options.vault ?? liveVault
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const admission = yield* Semaphore.make(1)
      const sameFile = (left: RefreshLock, right: RefreshLock) =>
        left.dev === right.dev && Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino)
      const removeAbandonedLock = Effect.gen(function* () {
        const observed = yield* fileSystem.stat(options.lockPath).pipe(Effect.option)
        if (Option.isNone(observed)) return false
        const text = yield* fileSystem.readFileString(options.lockPath).pipe(Effect.option)
        if (Option.isNone(text)) return false
        const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RefreshLockDisk))(text.value).pipe(
          Effect.option,
        )
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
        yield* fileSystem
          .makeDirectory(path.dirname(options.lockPath), { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(() => failure("Hosted credential refresh lock is unavailable")))
        const lockText = yield* Schema.encodeEffect(Schema.fromJsonString(RefreshLockDisk))({
          pid: process.pid,
        }).pipe(Effect.mapError(() => failure("Hosted credential refresh lock is unavailable")))
        const deadline = (yield* Clock.currentTimeMillis) + (options.lockTimeout ?? 30_000)
        while (true) {
          const written = yield* Effect.result(
            fileSystem.writeFileString(options.lockPath, lockText, { flag: "wx", mode: 0o600 }),
          )
          if (written._tag === "Success") {
            return yield* fileSystem
              .stat(options.lockPath)
              .pipe(Effect.mapError(() => failure("Hosted credential refresh lock is unavailable")))
          }
          if (
            !(written.failure.reason instanceof PlatformError.SystemError) ||
            written.failure.reason._tag !== "AlreadyExists"
          )
            return yield* failure("Hosted credential refresh lock is unavailable")
          yield* removeAbandonedLock
          if ((yield* Clock.currentTimeMillis) >= deadline)
            return yield* failure("Hosted credential refresh lock timed out")
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
        const identity = name(origin, deviceId)
        const stored = yield* Effect.tryPromise({
          try: () => vault.get({ service, name: identity }),
          catch: () => failure("Platform credential storage is unavailable"),
        })
        if (stored === null) return Option.none<Credential>()
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialDisk))(stored).pipe(
          Effect.mapError(() => failure("Hosted credentials are corrupt")),
        )
        return Option.some({
          refreshToken: Redacted.make(decoded.refreshToken),
          privateJwk: decoded.privateJwk,
        })
      })
      const save = Effect.fn("HostedCredentialStore.save")(function* (
        origin: string,
        deviceId: string,
        credential: Credential,
      ) {
        const identity = name(origin, deviceId)
        const value = yield* Schema.encodeEffect(Schema.fromJsonString(CredentialDisk))({
          formatVersion: 1,
          refreshToken: Redacted.value(credential.refreshToken),
          privateJwk: credential.privateJwk,
        }).pipe(Effect.mapError(() => failure("Hosted credentials could not be encoded")))
        yield* Effect.tryPromise({
          try: () => vault.set({ service, name: identity, value }),
          catch: () => failure("Platform credential storage is unavailable"),
        })
      })
      const remove = Effect.fn("HostedCredentialStore.remove")(function* (origin: string, deviceId: string) {
        const identity = name(origin, deviceId)
        return yield* Effect.tryPromise({
          try: () => vault.delete({ service, name: identity }),
          catch: () => failure("Platform credential storage is unavailable"),
        })
      })
      const serialized: CredentialStore["Service"]["serialized"] = (effect) =>
        admission.withPermits(1)(Effect.acquireUseRelease(acquireLock, () => effect, releaseLock))
      return CredentialStore.of({ load, save, remove, serialized })
    }),
  )
