import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import * as OpenAiAuthService from "@rika/product/openai-auth-service"

namespace OpenAiAuth {
  export import Store = OpenAiAuthService.Store
  export import StoreError = OpenAiAuthContract.StoreError
  export const maxCredentialFileSize = OpenAiAuthService.configuration.maxCredentialFileSize
  export const CredentialDisk = OpenAiAuthContract.CredentialDisk
  export type StoreInterface = {
    readonly load: import("effect").Effect.Effect<
      import("effect").Option.Option<typeof OpenAiAuthContract.CredentialDisk.Type>,
      OpenAiAuthContract.StoreError
    >
    readonly save: (
      credential: typeof OpenAiAuthContract.CredentialDisk.Type,
    ) => import("effect").Effect.Effect<void, OpenAiAuthContract.StoreError>
    readonly remove: import("effect").Effect.Effect<boolean, OpenAiAuthContract.StoreError>
    readonly serialized: <A, E, R>(
      effect: import("effect").Effect.Effect<A, E, R>,
    ) => import("effect").Effect.Effect<A, E | OpenAiAuthContract.StoreError, R>
  }
}
import { Clock, Effect, FileSystem, Function, Layer, Option, Path, Schema, Semaphore } from "effect"
import { randomBytes } from "node:crypto"

type FileHandle = FileSystem.File
type FileInfo = FileSystem.File.Info

export interface Options {
  readonly currentUid?: number
  readonly lockTimeout?: number
  readonly lockRetry?: number
  readonly maxSize?: number
  readonly trustedRoot?: string
}

const LockDisk = Schema.Struct({ pid: Schema.Int, nonce: Schema.String, createdAt: Schema.Finite })
type LockDisk = typeof LockDisk.Type
const failure = (kind: OpenAiAuth.StoreError["kind"], message: string) => OpenAiAuth.StoreError.make({ kind, message })
const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "reason" in cause &&
  typeof cause.reason === "object" && cause.reason !== null && "_tag" in cause.reason && cause.reason._tag === "NotFound"
const pathError = (cause: unknown): OpenAiAuth.StoreError => {
  if (Schema.is(OpenAiAuth.StoreError)(cause)) return cause
  if (isNotFound(cause)) return failure("missing", "Credential storage directory is missing")
  return failure("io", "Credential storage operation failed")
}
const syncIo = <A>(run: () => A, message = "Credential storage operation failed") =>
  Effect.try({ try: run, catch: () => failure("io", message) })
const unsafe = (message: string) => failure("unsafe", message)

const layerImpl = (filename: string, options: Options = {}) =>
  Layer.effect(
    OpenAiAuth.Store,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const fileSystem = yield* FileSystem.FileSystem
      const parent = path.dirname(filename)
      const lockname = `${filename}.lock`
      const uid = options.currentUid
      const maxSize = options.maxSize ?? OpenAiAuth.maxCredentialFileSize
      const trustedRoot = options.trustedRoot === undefined ? undefined : path.resolve(options.trustedRoot)
      const admission = yield* Semaphore.make(1)
      const rejectLink = (name: string) =>
        fileSystem.readLink(name).pipe(
          Effect.flatMap(() => Effect.fail(unsafe("Credential storage cannot use symbolic links"))),
          Effect.catch((cause) => isNotFound(cause) || !("kind" in cause) ? Effect.void : Effect.fail(cause)),
        )

      const validateStat = (
        stat: FileInfo,
        kind: "file" | "directory",
        maximumLinks = 1,
      ) =>
        Effect.gen(function* () {
          if (kind === "file" ? stat.type !== "File" : stat.type !== "Directory")
            return yield* unsafe("Credential storage type is unsafe")
          if (uid !== undefined && Option.getOrUndefined(stat.uid) !== uid) return yield* unsafe("Credential storage owner is unsafe")
          const links = Option.getOrElse(stat.nlink, () => 0)
          if (kind === "file" && ((stat.mode & 0o777) !== 0o600 || links < 1 || links > maximumLinks))
            return yield* unsafe("Credential storage file permissions or links are unsafe")
          if (kind === "directory" && (Number(stat.mode) & 0o077) !== 0)
            return yield* unsafe("Credential storage directory permissions are unsafe")
          return stat
        })
      const lstatOptional = (name: string) =>
        rejectLink(name).pipe(
          Effect.andThen(fileSystem.stat(name)),
          Effect.mapError(pathError),
          Effect.map(Option.some),
          Effect.catchTag("OpenAiCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.succeed(Option.none()) : Effect.fail(error),
          ),
        )
      const ensureParent = Effect.gen(function* () {
        const resolvedParent = path.resolve(parent)
        if (
          trustedRoot !== undefined &&
          resolvedParent !== trustedRoot &&
          !resolvedParent.startsWith(`${trustedRoot}${path.sep}`)
        ) {
          return yield* unsafe("Credential storage path is outside the profile data root")
        }
        if (trustedRoot === undefined) {
          yield* fileSystem.makeDirectory(parent, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
          yield* rejectLink(parent)
          yield* validateStat(yield* fileSystem.stat(parent).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))), "directory")
          return
        }
        const rootStat = yield* fileSystem.stat(trustedRoot).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
        if (
          rootStat.type !== "Directory" ||
          (uid !== undefined && Option.getOrUndefined(rootStat.uid) !== uid) ||
          (rootStat.mode & 0o022) !== 0
        ) {
          return yield* unsafe("Credential profile data root is unsafe")
        }
        let current = trustedRoot
        for (const component of path
          .relative(trustedRoot, resolvedParent)
          .split(path.sep)
          .filter((value) => value.length > 0)) {
          current = `${current}${path.sep}${component}`
          let stat = yield* lstatOptional(current)
          if (Option.isNone(stat)) {
            yield* fileSystem.makeDirectory(current, { mode: 0o700 }).pipe(
              Effect.mapError((cause) =>
                !isNotFound(cause)
                  ? failure("missing", "Credential storage directory appeared concurrently")
                  : failure("io", "Credential storage directory could not be created"),
              ),
              Effect.catchTag("OpenAiCredentialStoreError", (error) =>
                error.kind === "missing" ? Effect.void : Effect.fail(error),
              ),
            )
            stat = Option.some(yield* fileSystem.stat(current).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))))
          }
          yield* validateStat(Option.getOrThrow(stat), "directory")
        }
      })
      const sameStat = (left: FileInfo, right: FileInfo) =>
        left.dev === right.dev &&
        Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
        left.type === right.type &&
        Option.getOrUndefined(left.nlink) === Option.getOrUndefined(right.nlink) &&
        left.mode === right.mode &&
        Option.getOrUndefined(left.uid) === Option.getOrUndefined(right.uid)
      const openValidated = (name: string, missing: boolean, maximumLinks = 1) =>
        Effect.gen(function* () {
          yield* rejectLink(name)
          const pathStat = yield* fileSystem.stat(name).pipe(Effect.mapError((cause) =>
            isNotFound(cause) && missing ? failure("missing", "Credential file is missing") : failure("io", "Credential storage operation failed"),
          ))
          yield* validateStat(pathStat, "file", maximumLinks)
          const handle = yield* fileSystem.open(name, { flag: "r" }).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
          const stat = yield* handle.stat.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
          yield* validateStat(stat, "file", maximumLinks)
          if (!sameStat(pathStat, stat)) return yield* unsafe("Credential file changed while opening")
          return { handle, stat }
        })
      const readHandle = (handle: FileHandle, size: number, corruptMessage: string) =>
        Effect.gen(function* () {
          if (size > maxSize) return yield* failure("corrupt", "Credential file is too large")
          const buffer = new Uint8Array(size + 1)
          let offset = 0
          while (offset < buffer.length) {
            const bytesRead = Number(yield* handle.read(buffer.subarray(offset)).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))))
            if (bytesRead === 0) break
            offset += bytesRead
          }
          if (offset > maxSize) return yield* failure("corrupt", "Credential file is too large")
          const text = yield* syncIo(() =>
            new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)),
          ).pipe(Effect.mapError(() => failure("corrupt", corruptMessage)))
          const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
            Effect.mapError(() => failure("corrupt", corruptMessage)),
          )
          return json
        })
      const load = Effect.gen(function* () {
        yield* ensureParent
        const opened = yield* openValidated(filename, true).pipe(
          Effect.catchTag("OpenAiCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.void : Effect.fail(error),
          ),
        )
        if (opened === undefined) return Option.none<typeof OpenAiAuth.CredentialDisk.Type>()
        return yield* Effect.acquireUseRelease(
          Effect.succeed(opened),
          ({ handle, stat }) =>
            readHandle(handle, Number(stat.size), "Credential file is corrupt").pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(OpenAiAuth.CredentialDisk)),
              Effect.mapError(() => failure("corrupt", "Credential file is corrupt")),
              Effect.map(Option.some),
            ),
          () => Effect.void,
        )
      })
      const randomNonce = () => syncIo(() => randomBytes(24).toString("hex"))
      const validateDestination = Effect.scoped(openValidated(filename, true)).pipe(
        Effect.asVoid,
        Effect.catchTag("OpenAiCredentialStoreError", (error) =>
          error.kind === "missing" ? Effect.void : Effect.fail(error),
        ),
      )
      const syncParent = Effect.scoped(fileSystem.open(parent, { flag: "r" }).pipe(
        Effect.flatMap((handle) => handle.sync),
        Effect.mapError(() => failure("io", "Credential storage operation failed")),
      ))
      const save = (credential: typeof OpenAiAuth.CredentialDisk.Type) =>
        Effect.gen(function* () {
          yield* ensureParent
          const encodedText = yield* Schema.encodeEffect(Schema.fromJsonString(OpenAiAuth.CredentialDisk))(
            credential,
          ).pipe(Effect.mapError(() => failure("corrupt", "Credential value is invalid")))
          const encoded = new TextEncoder().encode(encodedText)
          const temp = `${filename}.tmp-${yield* randomNonce()}`
          yield* Effect.acquireUseRelease(
            fileSystem.open(temp, { flag: "wx", mode: 0o600 }).pipe(Effect.mapError(() => failure("io", "Credential temporary file could not be created"))),
            (handle) =>
              Effect.gen(function* () {
                yield* handle.writeAll(encoded).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
                yield* handle.sync.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
                yield* validateStat(yield* handle.stat.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))), "file")
                yield* validateDestination
                yield* fileSystem.rename(temp, filename).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
                yield* validateDestination
                yield* syncParent
              }),
            () => Effect.void,
          ).pipe(Effect.ensuring(fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)))
        })
      const remove = Effect.gen(function* () {
        yield* ensureParent
        const opened = yield* openValidated(filename, true).pipe(
          Effect.catchTag("OpenAiCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.void : Effect.fail(error),
          ),
        )
        if (opened === undefined) return false
        const current = yield* fileSystem.stat(filename).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
        if (!sameStat(current, opened.stat)) {
          return yield* unsafe("Credential file changed during removal")
        }
        yield* fileSystem.remove(filename).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
        yield* syncParent
        return true
      })

      const readLock = (handle: FileHandle, stat: FileInfo) =>
        readHandle(handle, Number(stat.size), "Credential lock is corrupt").pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(LockDisk)(value).pipe(
              Effect.mapError(() => unsafe("Credential lock is unsafe or corrupt")),
            ),
          ),
          Effect.mapError((error) =>
            error.kind === "corrupt" ? unsafe("Credential lock is unsafe or corrupt") : error,
          ),
        ) as Effect.Effect<LockDisk, OpenAiAuth.StoreError>
      const release = (held: { handle: FileHandle; stat: FileInfo; value: LockDisk }) =>
        Effect.gen(function* () {
          const current = yield* openValidated(lockname, true, 2).pipe(Effect.option)
          if (Option.isSome(current)) {
            const value = yield* readLock(current.value.handle, current.value.stat).pipe(Effect.option)
            if (
              Option.isSome(value) &&
              current.value.stat.dev === held.stat.dev &&
              Option.getOrUndefined(current.value.stat.ino) === Option.getOrUndefined(held.stat.ino) &&
              value.value.nonce === held.value.nonce
            )
              yield* fileSystem.remove(lockname).pipe(Effect.ignore)
          }
        }).pipe(Effect.ignore)
      const acquire = Effect.gen(function* () {
        yield* ensureParent
        const deadline = (yield* Clock.currentTimeMillis) + (options.lockTimeout ?? 35_000)
        while (true) {
          const ownValue = { pid: process.pid, nonce: yield* randomNonce(), createdAt: yield* Clock.currentTimeMillis }
          const temporary = `${lockname}.tmp-${yield* randomNonce()}`
          const created = yield* fileSystem.open(temporary, { flag: "wx", mode: 0o600 }).pipe(
            Effect.mapError(() => failure("io", "Credential lock temporary file could not be created")),
          )
          const published = yield* Effect.gen(function* () {
            const lockEncoded = yield* Schema.encodeEffect(Schema.fromJsonString(LockDisk))(ownValue).pipe(
              Effect.mapError(() => failure("io", "Credential lock encoding failed")),
            )
            const bytes = new TextEncoder().encode(lockEncoded)
            yield* created.writeAll(bytes).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
            yield* created.sync.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
            yield* validateStat(yield* created.stat.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))), "file")
            return yield* fileSystem.link(temporary, lockname).pipe(
              Effect.mapError((cause) =>
                !isNotFound(cause)
                  ? failure("busy", "Credential lock exists")
                  : failure("io", "Credential lock could not be published"),
              ),
              Effect.as(true),
              Effect.catchTag("OpenAiCredentialStoreError", (error) =>
                error.kind === "busy" ? Effect.succeed(false) : Effect.fail(error),
              ),
            )
          }).pipe(
            Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          )
          if (published) {
            const stat = yield* created.stat.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
            yield* validateStat(stat, "file")
            return { handle: created, stat, value: ownValue }
          }
          const observed = yield* openValidated(lockname, true, 2).pipe(
            Effect.catchTag("OpenAiCredentialStoreError", (error) =>
              error.kind === "missing" ? Effect.void : Effect.fail(error),
            ),
          )
          if (observed === undefined) continue
          yield* Effect.acquireUseRelease(
            Effect.succeed(observed),
            ({ handle, stat }) => readLock(handle, stat),
            () => Effect.void,
          )
          if ((yield* Clock.currentTimeMillis) >= deadline) return yield* failure("busy", "Credential storage is busy")
          yield* Effect.sleep(options.lockRetry ?? 50)
        }
      })
      const crossProcess = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(acquire, () => effect, release)
      const serialized: OpenAiAuth.StoreInterface["serialized"] = (effect) =>
        Effect.scoped(effect.pipe(crossProcess, admission.withPermits(1)))
      return OpenAiAuth.Store.of({ load: Effect.scoped(load), save: (credential) => Effect.scoped(save(credential)), remove: Effect.scoped(remove), serialized })
    }),
  )

export const layer: {
  (filename: string, options?: Options): Layer.Layer<OpenAiAuth.Store>
  (options?: Options): (filename: string) => Layer.Layer<OpenAiAuth.Store>
} = Function.dual((args) => typeof args[0] === "string", layerImpl)
