import { OpenAiAuth } from "@rika/app"
import { Clock, Effect, Function, Layer, Option, Schema, Semaphore } from "effect"
import { randomBytes } from "node:crypto"

const nativeDescriptorFs = process.getBuiltinModule("fs")
const { constants } = nativeDescriptorFs
const { lstat, link, mkdir, open, rename, unlink } = nativeDescriptorFs.promises
const { dirname, relative, resolve, sep } = process.getBuiltinModule("path")
type FileHandle = Awaited<ReturnType<typeof open>>

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
const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined
const io = <A>(run: () => Promise<A>, message = "Credential storage operation failed") =>
  Effect.tryPromise({ try: run, catch: () => failure("io", message) })
const syncIo = <A>(run: () => A, message = "Credential storage operation failed") =>
  Effect.try({ try: run, catch: () => failure("io", message) })
const unsafe = (message: string) => failure("unsafe", message)

const layerImpl = (filename: string, options: Options = {}) =>
  Layer.effect(
    OpenAiAuth.Store,
    Effect.gen(function* () {
      const parent = dirname(filename)
      const lockname = `${filename}.lock`
      const uid = options.currentUid
      const maxSize = options.maxSize ?? OpenAiAuth.maxCredentialFileSize
      const trustedRoot = options.trustedRoot === undefined ? undefined : resolve(options.trustedRoot)
      const admission = yield* Semaphore.make(1)

      const validateStat = (
        stat: Awaited<ReturnType<FileHandle["stat"]>>,
        kind: "file" | "directory",
        maximumLinks = 1,
      ) =>
        Effect.gen(function* () {
          if (kind === "file" ? !stat.isFile() : !stat.isDirectory())
            return yield* unsafe("Credential storage type is unsafe")
          if (uid !== undefined && stat.uid !== uid) return yield* unsafe("Credential storage owner is unsafe")
          if (kind === "file" && ((Number(stat.mode) & 0o777) !== 0o600 || stat.nlink < 1 || stat.nlink > maximumLinks))
            return yield* unsafe("Credential storage file permissions or links are unsafe")
          if (kind === "directory" && (Number(stat.mode) & 0o077) !== 0)
            return yield* unsafe("Credential storage directory permissions are unsafe")
          return stat
        })
      const lstatOptional = (name: string) =>
        Effect.tryPromise({
          try: () => lstat(name),
          catch: (cause) =>
            code(cause) === "ENOENT"
              ? failure("missing", "Credential storage directory is missing")
              : failure("io", "Credential storage operation failed"),
        }).pipe(
          Effect.map(Option.some),
          Effect.catchTag("OpenAiCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.succeed(Option.none()) : Effect.fail(error),
          ),
        )
      const ensureParent = Effect.gen(function* () {
        const resolvedParent = resolve(parent)
        if (
          trustedRoot !== undefined &&
          resolvedParent !== trustedRoot &&
          !resolvedParent.startsWith(`${trustedRoot}${sep}`)
        ) {
          return yield* unsafe("Credential storage path is outside the profile data root")
        }
        if (trustedRoot === undefined) {
          yield* io(() => mkdir(parent, { recursive: true, mode: 0o700 }))
          yield* validateStat(yield* io(() => lstat(parent)), "directory")
          return
        }
        const rootStat = yield* io(() => lstat(trustedRoot))
        if (
          !rootStat.isDirectory() ||
          (uid !== undefined && rootStat.uid !== uid) ||
          (Number(rootStat.mode) & 0o022) !== 0
        ) {
          return yield* unsafe("Credential profile data root is unsafe")
        }
        let current = trustedRoot
        for (const component of relative(trustedRoot, resolvedParent)
          .split(sep)
          .filter((value) => value.length > 0)) {
          current = `${current}${sep}${component}`
          let stat = yield* lstatOptional(current)
          if (Option.isNone(stat)) {
            yield* Effect.tryPromise({
              try: () => mkdir(current, { mode: 0o700 }),
              catch: (cause) =>
                code(cause) === "EEXIST"
                  ? failure("missing", "Credential storage directory appeared concurrently")
                  : failure("io", "Credential storage directory could not be created"),
            }).pipe(
              Effect.catchTag("OpenAiCredentialStoreError", (error) =>
                error.kind === "missing" ? Effect.void : Effect.fail(error),
              ),
            )
            stat = Option.some(yield* io(() => lstat(current)))
          }
          yield* validateStat(Option.getOrThrow(stat), "directory")
        }
      })
      const openValidated = (name: string, missing: boolean, maximumLinks = 1) =>
        Effect.gen(function* () {
          const handle = yield* Effect.tryPromise({
            try: () => open(name, constants.O_RDONLY | constants.O_NOFOLLOW),
            catch: (cause) =>
              code(cause) === "ENOENT" && missing
                ? failure("missing", "Credential file is missing")
                : code(cause) === "ELOOP"
                  ? unsafe("Credential storage cannot use symbolic links")
                  : failure("io", "Credential storage operation failed"),
          })
          const stat = yield* io(() => handle.stat()).pipe(
            Effect.tapError(() => io(() => handle.close()).pipe(Effect.ignore)),
          )
          yield* validateStat(stat, "file", maximumLinks).pipe(
            Effect.tapError(() => io(() => handle.close()).pipe(Effect.ignore)),
          )
          return { handle, stat }
        })
      const readHandle = (handle: FileHandle, size: number, corruptMessage: string) =>
        Effect.gen(function* () {
          if (size > maxSize) return yield* failure("corrupt", "Credential file is too large")
          const buffer = new Uint8Array(size + 1)
          let offset = 0
          while (offset < buffer.length) {
            const result = yield* io(() => handle.read(buffer, offset, buffer.length - offset, offset))
            if (result.bytesRead === 0) break
            offset += result.bytesRead
          }
          if (offset > maxSize) return yield* failure("corrupt", "Credential file is too large")
          const text = yield* syncIo(() =>
            new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)),
          ).pipe(Effect.mapError(() => failure("corrupt", corruptMessage)))
          const json = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
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
          ({ handle }) => io(() => handle.close()).pipe(Effect.ignore),
        )
      })
      const randomNonce = () => syncIo(() => randomBytes(24).toString("hex"))
      const validateDestination = Effect.gen(function* () {
        const opened = yield* openValidated(filename, true)
        yield* io(() => opened.handle.close())
      }).pipe(
        Effect.catchTag("OpenAiCredentialStoreError", (error) =>
          error.kind === "missing" ? Effect.void : Effect.fail(error),
        ),
      )
      const syncParent = Effect.acquireUseRelease(
        io(() => open(parent, constants.O_RDONLY | constants.O_DIRECTORY)),
        (handle) => io(() => handle.sync()),
        (handle) => io(() => handle.close()).pipe(Effect.ignore),
      )
      const save = (credential: typeof OpenAiAuth.CredentialDisk.Type) =>
        Effect.gen(function* () {
          yield* ensureParent
          const encodedText = yield* Schema.encodeEffect(Schema.fromJsonString(OpenAiAuth.CredentialDisk))(
            credential,
          ).pipe(Effect.mapError(() => failure("corrupt", "Credential value is invalid")))
          const encoded = new TextEncoder().encode(encodedText)
          const temp = `${filename}.tmp-${yield* randomNonce()}`
          yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () =>
                open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600),
              catch: () => failure("io", "Credential temporary file could not be created"),
            }),
            (handle) =>
              Effect.gen(function* () {
                yield* validateStat(yield* io(() => handle.stat()), "file")
                let offset = 0
                while (offset < encoded.length) offset += (yield* io(() => handle.write(encoded, offset))).bytesWritten
                yield* io(() => handle.sync())
                yield* io(() => handle.close())
                yield* validateDestination
                yield* io(() => rename(temp, filename))
                yield* validateDestination
                yield* syncParent
              }),
            (handle) => io(() => handle.close()).pipe(Effect.ignore),
          ).pipe(Effect.ensuring(io(() => unlink(temp)).pipe(Effect.ignore)))
        })
      const remove = Effect.gen(function* () {
        yield* ensureParent
        const opened = yield* openValidated(filename, true).pipe(
          Effect.catchTag("OpenAiCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.void : Effect.fail(error),
          ),
        )
        if (opened === undefined) return false
        yield* io(() => opened.handle.close())
        const current = yield* io(() => lstat(filename))
        if (current.dev !== opened.stat.dev || current.ino !== opened.stat.ino) {
          return yield* unsafe("Credential file changed during removal")
        }
        yield* io(() => unlink(filename))
        yield* syncParent
        return true
      })

      const readLock = (handle: FileHandle, stat: Awaited<ReturnType<FileHandle["stat"]>>) =>
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
      const release = (held: { handle: FileHandle; stat: Awaited<ReturnType<FileHandle["stat"]>>; value: LockDisk }) =>
        Effect.gen(function* () {
          const current = yield* openValidated(lockname, true, 2).pipe(Effect.option)
          if (Option.isSome(current)) {
            const value = yield* readLock(current.value.handle, current.value.stat).pipe(Effect.option)
            yield* io(() => current.value.handle.close()).pipe(Effect.ignore)
            if (
              Option.isSome(value) &&
              current.value.stat.dev === held.stat.dev &&
              current.value.stat.ino === held.stat.ino &&
              value.value.nonce === held.value.nonce
            )
              yield* io(() => unlink(lockname)).pipe(Effect.ignore)
          }
          yield* io(() => held.handle.close()).pipe(Effect.ignore)
        }).pipe(Effect.ignore)
      const acquire = Effect.gen(function* () {
        yield* ensureParent
        const deadline = (yield* Clock.currentTimeMillis) + (options.lockTimeout ?? 35_000)
        while (true) {
          const ownValue = { pid: process.pid, nonce: yield* randomNonce(), createdAt: yield* Clock.currentTimeMillis }
          const temporary = `${lockname}.tmp-${yield* randomNonce()}`
          const created = yield* Effect.tryPromise({
            try: () =>
              open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600),
            catch: () => failure("io", "Credential lock temporary file could not be created"),
          })
          const published = yield* Effect.gen(function* () {
            const lockEncoded = yield* Schema.encodeEffect(Schema.fromJsonString(LockDisk))(ownValue).pipe(
              Effect.mapError(() => failure("io", "Credential lock encoding failed")),
            )
            const bytes = new TextEncoder().encode(lockEncoded)
            let offset = 0
            while (offset < bytes.length) offset += (yield* io(() => created.write(bytes, offset))).bytesWritten
            yield* io(() => created.sync())
            yield* validateStat(yield* io(() => created.stat()), "file")
            return yield* Effect.tryPromise({
              try: () => link(temporary, lockname),
              catch: (cause) =>
                code(cause) === "EEXIST"
                  ? failure("busy", "Credential lock exists")
                  : failure("io", "Credential lock could not be published"),
            }).pipe(
              Effect.as(true),
              Effect.catchTag("OpenAiCredentialStoreError", (error) =>
                error.kind === "busy" ? Effect.succeed(false) : Effect.fail(error),
              ),
            )
          }).pipe(
            Effect.ensuring(io(() => unlink(temporary)).pipe(Effect.ignore)),
            Effect.onError(() => io(() => created.close()).pipe(Effect.ignore)),
          )
          if (!published) {
            yield* io(() => created.close()).pipe(Effect.ignore)
          }
          if (published) {
            const stat = yield* io(() => created.stat())
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
            ({ handle }) => io(() => handle.close()).pipe(Effect.ignore),
          )
          if ((yield* Clock.currentTimeMillis) >= deadline) return yield* failure("busy", "Credential storage is busy")
          yield* Effect.sleep(options.lockRetry ?? 50)
        }
      })
      const crossProcess = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(acquire, () => effect, release)
      const serialized: OpenAiAuth.StoreInterface["serialized"] = (effect) =>
        effect.pipe(crossProcess, admission.withPermits(1))
      return OpenAiAuth.Store.of({ load, save, remove, serialized })
    }),
  )

export const layer: {
  (filename: string, options?: Options): Layer.Layer<OpenAiAuth.Store>
  (options?: Options): (filename: string) => Layer.Layer<OpenAiAuth.Store>
} = Function.dual((args) => typeof args[0] === "string", layerImpl)
