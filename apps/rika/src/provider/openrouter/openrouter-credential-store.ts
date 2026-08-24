import { ProviderCredentialStore, ProviderCredentialStoreError } from "@rika/product/provider-credential-store"
import { Effect, FileSystem, Function, Layer, Option, Path, Redacted, Schema } from "effect"
import { randomBytes } from "node:crypto"

type FileHandle = FileSystem.File
type FileInfo = FileSystem.File.Info

export interface Options {
  readonly currentUid?: number
  readonly maxSize?: number
  readonly trustedRoot?: string
}

const CredentialDisk = Schema.Struct({ apiKey: Schema.String })
const credentialIdentity = "openrouter"

const failure = (kind: ProviderCredentialStoreError["kind"], message: string) =>
  ProviderCredentialStoreError.make({ kind, message })
const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "reason" in cause && typeof cause.reason === "object" &&
  cause.reason !== null && "_tag" in cause.reason && cause.reason._tag === "NotFound"
const pathError = (cause: unknown): ProviderCredentialStoreError => {
  if (Schema.is(ProviderCredentialStoreError)(cause)) return cause
  if (isNotFound(cause)) return failure("missing", "Credential storage directory is missing")
  return failure("io", "Credential storage operation failed")
}
const syncIo = <A>(run: () => A, message = "Credential storage operation failed") =>
  Effect.try({ try: run, catch: () => failure("io", message) })
const unsafe = (message: string) => failure("unsafe", message)

const validateStat = (
  stat: FileInfo,
  kind: "file" | "directory",
  uid: number | undefined,
) =>
  Effect.gen(function* () {
    if (kind === "file" ? stat.type !== "File" : stat.type !== "Directory")
      return yield* unsafe("Credential storage type is unsafe")
    if (uid !== undefined && Option.getOrUndefined(stat.uid) !== uid) return yield* unsafe("Credential storage owner is unsafe")
    if (kind === "file" && ((Number(stat.mode) & 0o777) !== 0o600 || Option.getOrElse(stat.nlink, () => 0) !== 1))
      return yield* unsafe("Credential storage file permissions are unsafe")
    if (kind === "directory" && (Number(stat.mode) & 0o077) !== 0)
      return yield* unsafe("Credential storage directory permissions are unsafe")
    return stat
  })

export const layer: {
  (options?: Options): (filename: string) => Layer.Layer<ProviderCredentialStore, never, never>
  (filename: string, options?: Options): Layer.Layer<ProviderCredentialStore, never, never>
} = Function.dual(2, (filename: string, options: Options = {}) =>
  Layer.effect(
    ProviderCredentialStore,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const fileSystem = yield* FileSystem.FileSystem
      const parent = path.dirname(filename)
      const uid = options.currentUid
      const maxSize = options.maxSize ?? 16_384
      const trustedRoot = options.trustedRoot === undefined ? undefined : path.resolve(options.trustedRoot)
      const rejectLink = (name: string) => fileSystem.readLink(name).pipe(
        Effect.flatMap(() => Effect.fail(unsafe("Credential storage cannot use symbolic links"))),
        Effect.catch((cause) => isNotFound(cause) || !("kind" in cause) ? Effect.void : Effect.fail(cause)),
      )

      const lstatOptional = (name: string) =>
        rejectLink(name).pipe(
          Effect.andThen(fileSystem.stat(name)),
          Effect.mapError(pathError),
          Effect.map(Option.some),
          Effect.catchTag("ProviderCredentialStoreError", (error) =>
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
          yield* validateStat(yield* fileSystem.stat(parent).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))), "directory", uid)
          return
        }
        const rootStat = yield* fileSystem.stat(trustedRoot).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
        if (
          rootStat.type !== "Directory" ||
          (uid !== undefined && Option.getOrUndefined(rootStat.uid) !== uid) ||
          (Number(rootStat.mode) & 0o022) !== 0
        ) {
          return yield* unsafe("Credential profile data root is unsafe")
        }
        let current = trustedRoot
        for (const component of path
          .relative(trustedRoot, resolvedParent)
          .split(path.sep)
          .filter((value) => value.length > 0)) {
          current = `${current}${path.sep}${component}`
          const existing = yield* lstatOptional(current)
          if (Option.isNone(existing)) {
            yield* fileSystem.makeDirectory(current, { mode: 0o700 }).pipe(
              Effect.mapError(() => failure("io", "Credential storage directory could not be created")),
              Effect.catchTag("ProviderCredentialStoreError", () => Effect.void),
            )
          }
          yield* validateStat(yield* fileSystem.stat(current).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))), "directory", uid)
        }
      })
      const sameStat = (left: FileInfo, right: FileInfo) => left.dev === right.dev &&
        Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) && left.type === right.type &&
        Option.getOrUndefined(left.nlink) === Option.getOrUndefined(right.nlink) && left.mode === right.mode &&
        Option.getOrUndefined(left.uid) === Option.getOrUndefined(right.uid)

      const openValidated = (name: string, missing: boolean) =>
        Effect.gen(function* () {
          yield* rejectLink(name)
          const pathStat = yield* fileSystem.stat(name).pipe(Effect.mapError((cause) => isNotFound(cause) && missing
            ? failure("missing", "Credential file is missing") : failure("io", "Credential storage operation failed")))
          yield* validateStat(pathStat, "file", uid)
          const handle = yield* fileSystem.open(name, { flag: "r" }).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
          const stat = yield* handle.stat.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
          yield* validateStat(stat, "file", uid)
          if (!sameStat(pathStat, stat)) return yield* unsafe("Credential file changed while opening")
          return { handle, stat }
        })

      const readFile = (handle: FileHandle, size: number) =>
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
          const text = yield* syncIo(
            () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)),
            "Credential file is corrupt",
          )
          const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
            Effect.mapError(() => failure("corrupt", "Credential file is corrupt")),
          )
          return yield* Schema.decodeUnknownEffect(CredentialDisk)(json).pipe(
            Effect.mapError(() => failure("corrupt", "Credential file is corrupt")),
          )
        })

      const load = Effect.gen(function* () {
        yield* ensureParent
        const opened = yield* openValidated(filename, true).pipe(
          Effect.catchTag("ProviderCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.void : Effect.fail(error),
          ),
        )
        if (opened === undefined) return Option.none<Redacted.Redacted<string>>()
        return yield* Effect.acquireUseRelease(
          Effect.succeed(opened),
          ({ handle, stat }) =>
            readFile(handle, Number(stat.size)).pipe(
              Effect.map((credential) => Option.some(Redacted.make(credential.apiKey))),
            ),
          () => Effect.void,
        )
      })

      const save = (apiKey: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          yield* ensureParent
          const encodedText = yield* Schema.encodeEffect(Schema.fromJsonString(CredentialDisk))({
            apiKey: Redacted.value(apiKey),
          }).pipe(Effect.mapError(() => failure("corrupt", "Credential value is invalid")))
          const encoded = new TextEncoder().encode(encodedText)
          const temp = `${filename}.tmp-${yield* syncIo(() => randomBytes(12).toString("hex"))}`
          yield* Effect.acquireUseRelease(
            fileSystem.open(temp, { flag: "wx", mode: 0o600 }).pipe(Effect.mapError(() => failure("io", "Credential temporary file could not be created"))),
            (handle) =>
              Effect.gen(function* () {
                yield* handle.writeAll(encoded).pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
                yield* handle.sync.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed")))
                yield* validateStat(yield* handle.stat.pipe(Effect.mapError(() => failure("io", "Credential storage operation failed"))), "file", uid)
              }),
            () => Effect.void,
          )
          yield* fileSystem.rename(temp, filename).pipe(Effect.mapError(() => failure("io", "Credential file could not be committed")))
        })

      const remove = Effect.gen(function* () {
        yield* ensureParent
        return yield* fileSystem.remove(filename).pipe(
          Effect.mapError((cause) => isNotFound(cause) ? failure("missing", "Credential file is missing") : failure("io", "Credential storage operation failed")),
          Effect.catchTag("ProviderCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.succeed(false) : Effect.fail(error),
          ),
          Effect.as(true),
        )
      })

      return ProviderCredentialStore.of({
        load: (identity) => (identity === credentialIdentity ? Effect.scoped(load) : Effect.succeed(Option.none())),
        save: (identity, apiKey) =>
          identity === credentialIdentity
            ? Effect.scoped(save(apiKey))
            : Effect.fail(failure("unsafe", "Unknown credential identity")),
        remove: (identity) => (identity === credentialIdentity ? Effect.scoped(remove) : Effect.succeed(false)),
      })
    }),
  ),
)
