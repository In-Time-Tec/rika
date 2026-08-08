import { ProviderCredentialStore, ProviderCredentialStoreError } from "@rika/product/provider-credential-store"
import { Effect, Function, Layer, Option, Redacted, Schema } from "effect"
import { randomBytes } from "node:crypto"

const nativeDescriptorFs = process.getBuiltinModule("fs")
const { constants } = nativeDescriptorFs
const { lstat, mkdir, open, rename, unlink } = nativeDescriptorFs.promises
const { dirname, relative, resolve, sep } = process.getBuiltinModule("path")
type FileHandle = Awaited<ReturnType<typeof open>>

export interface Options {
  readonly currentUid?: number
  readonly maxSize?: number
  readonly trustedRoot?: string
}

const CredentialDisk = Schema.Struct({ apiKey: Schema.String })
const credentialIdentity = "openrouter"

const failure = (kind: ProviderCredentialStoreError["kind"], message: string) =>
  ProviderCredentialStoreError.make({ kind, message })
const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined
const io = <A>(run: () => Promise<A>, message = "Credential storage operation failed") =>
  Effect.tryPromise({ try: run, catch: () => failure("io", message) })
const syncIo = <A>(run: () => A, message = "Credential storage operation failed") =>
  Effect.try({ try: run, catch: () => failure("io", message) })
const unsafe = (message: string) => failure("unsafe", message)

const validateStat = (
  stat: Awaited<ReturnType<FileHandle["stat"]>>,
  kind: "file" | "directory",
  uid: number | undefined,
) =>
  Effect.gen(function* () {
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory())
      return yield* unsafe("Credential storage type is unsafe")
    if (uid !== undefined && stat.uid !== uid) return yield* unsafe("Credential storage owner is unsafe")
    if (kind === "file" && (Number(stat.mode) & 0o777) !== 0o600)
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
    Effect.sync(() => {
      const parent = dirname(filename)
      const uid = options.currentUid
      const maxSize = options.maxSize ?? 16_384
      const trustedRoot = options.trustedRoot === undefined ? undefined : resolve(options.trustedRoot)

      const lstatOptional = (name: string) =>
        Effect.tryPromise({
          try: () => lstat(name),
          catch: (cause) =>
            code(cause) === "ENOENT"
              ? failure("missing", "Credential storage directory is missing")
              : failure("io", "Credential storage operation failed"),
        }).pipe(
          Effect.map(Option.some),
          Effect.catchTag("ProviderCredentialStoreError", (error) =>
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
          yield* validateStat(yield* io(() => lstat(parent)), "directory", uid)
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
          const existing = yield* lstatOptional(current)
          if (Option.isNone(existing)) {
            yield* Effect.tryPromise({
              try: () => mkdir(current, { mode: 0o700 }),
              catch: () => failure("io", "Credential storage directory could not be created"),
            }).pipe(Effect.catchTag("ProviderCredentialStoreError", () => Effect.void))
          }
          yield* validateStat(yield* io(() => lstat(current)), "directory", uid)
        }
      })

      const openValidated = (name: string, missing: boolean) =>
        Effect.gen(function* () {
          const handle = yield* Effect.tryPromise({
            try: () => open(name, constants.O_RDONLY | constants.O_NOFOLLOW),
            catch: (cause) => {
              if (code(cause) === "ENOENT" && missing) return failure("missing", "Credential file is missing")
              if (code(cause) === "ELOOP") return unsafe("Credential storage cannot use symbolic links")
              return failure("io", "Credential storage operation failed")
            },
          })
          const stat = yield* io(() => handle.stat()).pipe(
            Effect.tapError(() => io(() => handle.close()).pipe(Effect.ignore)),
          )
          yield* validateStat(stat, "file", uid).pipe(
            Effect.tapError(() => io(() => handle.close()).pipe(Effect.ignore)),
          )
          return handle
        })

      const readFile = (handle: FileHandle, size: number) =>
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
          const text = yield* syncIo(
            () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)),
            "Credential file is corrupt",
          )
          const json = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
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
          (handle) =>
            io(() => handle.stat()).pipe(
              Effect.flatMap((stat) => readFile(handle, Number(stat.size))),
              Effect.map((credential) => Option.some(Redacted.make(credential.apiKey))),
            ),
          (handle) => io(() => handle.close()).pipe(Effect.ignore),
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
            Effect.tryPromise({
              try: () =>
                open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600),
              catch: () => failure("io", "Credential temporary file could not be created"),
            }),
            (handle) =>
              Effect.gen(function* () {
                yield* validateStat(yield* io(() => handle.stat()), "file", uid)
                let offset = 0
                while (offset < encoded.length) {
                  offset += (yield* io(() => handle.write(encoded, offset))).bytesWritten
                }
                yield* io(() => handle.sync())
              }).pipe(Effect.tapError(() => io(() => handle.close()).pipe(Effect.ignore))),
            (handle) => io(() => handle.close()).pipe(Effect.ignore),
          )
          yield* Effect.tryPromise({
            try: () => rename(temp, filename),
            catch: () => failure("io", "Credential file could not be committed"),
          })
        })

      const remove = Effect.gen(function* () {
        yield* ensureParent
        return yield* Effect.tryPromise({
          try: () => unlink(filename),
          catch: () => failure("missing", "Credential file is missing"),
        }).pipe(
          Effect.catchTag("ProviderCredentialStoreError", (error) =>
            error.kind === "missing" ? Effect.succeed(false) : Effect.fail(error),
          ),
          Effect.as(true),
        )
      })

      return ProviderCredentialStore.of({
        load: (identity) => (identity === credentialIdentity ? load : Effect.succeed(Option.none())),
        save: (identity, apiKey) =>
          identity === credentialIdentity
            ? save(apiKey)
            : Effect.fail(failure("unsafe", "Unknown credential identity")),
        remove: (identity) => (identity === credentialIdentity ? remove : Effect.succeed(false)),
      })
    }),
  ),
)
