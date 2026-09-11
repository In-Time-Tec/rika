import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { Context, Crypto, Effect, Encoding, FileSystem, Layer, Option, Redacted, Result, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { decodeArchive, inspectArchive } from "./archive"
import {
  Archive,
  MaximumArchiveBytes,
  MaximumEncryptedArchiveBytes,
  StoredArchive,
  WorkspaceSeedId,
  type EncodedArchive,
} from "./contract"

export class WorkspaceSeedVaultError extends Schema.TaggedError<WorkspaceSeedVaultError>()("WorkspaceSeedVaultError", {
  kind: Schema.Literals(["corrupt", "crypto", "missing", "object", "scope", "size"]),
  message: Schema.String,
}) {}

export interface ObjectStoreContract {
  readonly put: (key: string, value: Uint8Array) => Effect.Effect<void, WorkspaceSeedVaultError>
  readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, WorkspaceSeedVaultError>
  readonly remove: (key: string) => Effect.Effect<void, WorkspaceSeedVaultError>
}

export class ObjectStore extends Context.Service<ObjectStore, ObjectStoreContract>()(
  "@rika/workspace-input/vault/ObjectStore",
) {}

export interface WorkspaceSeedVaultContract {
  readonly store: (seedId: string, archive: EncodedArchive) => Effect.Effect<StoredArchive, WorkspaceSeedVaultError>
  readonly load: (seedId: string, stored: StoredArchive) => Effect.Effect<Archive, WorkspaceSeedVaultError>
  readonly remove: (seedId: string, stored: StoredArchive) => Effect.Effect<void, WorkspaceSeedVaultError>
}

export class WorkspaceSeedVault extends Context.Service<WorkspaceSeedVault, WorkspaceSeedVaultContract>()(
  "@rika/workspace-input/vault/WorkspaceSeedVault",
) {}

export interface WorkspaceSeedVaultOptions {
  readonly encryptionKey: Redacted.Redacted<string>
}

export interface S3Credentials {
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string>
}

export interface S3ObjectStoreOptions {
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly forcePathStyle?: boolean
  readonly credentials?: S3Credentials
}

interface ResolvedS3Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  sessionToken?: string
}

const encoder = new TextEncoder()
const magic = encoder.encode("rika-workspace-input-seed-v1\n")
const nonceLength = 12
const authenticationTagLength = 16
const objectNamespace = "workspace-input/v1/workspace-seeds"

const failure = (kind: WorkspaceSeedVaultError["kind"], message: string) =>
  WorkspaceSeedVaultError.make({ kind, message })

const decodeKey = (key: Redacted.Redacted<string>) =>
  Result.match(Encoding.decodeBase64(Redacted.value(key)), {
    onFailure: () => Effect.fail(failure("crypto", "Workspace seed encryption key is invalid")),
    onSuccess: (bytes) =>
      bytes.byteLength === 32
        ? Effect.succeed(bytes)
        : Effect.fail(failure("crypto", "Workspace seed encryption key must contain 32 bytes")),
  })

const importKey = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: () => failure("crypto", "Workspace seed encryption key could not be loaded"),
  })

const encrypt = (key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
    catch: () => failure("crypto", "Workspace seed encryption failed"),
  }).pipe(
    Effect.map((ciphertext) => {
      const encrypted = new Uint8Array(magic.byteLength + nonce.byteLength + ciphertext.byteLength)
      encrypted.set(magic)
      encrypted.set(nonce, magic.byteLength)
      encrypted.set(new Uint8Array(ciphertext), magic.byteLength + nonce.byteLength)
      return encrypted
    }),
  )

const decrypt = (key: CryptoKey, aad: Uint8Array, encrypted: Uint8Array) =>
  Effect.gen(function* () {
    if (
      encrypted.byteLength <= magic.byteLength + nonceLength + authenticationTagLength ||
      !magic.every((value, index) => encrypted[index] === value)
    )
      return yield* failure("corrupt", "Encrypted Workspace seed header is invalid")
    const nonce = encrypted.slice(magic.byteLength, magic.byteLength + nonceLength)
    const ciphertext = encrypted.slice(magic.byteLength + nonceLength)
    return new Uint8Array(
      yield* Effect.tryPromise({
        try: () =>
          globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ciphertext),
        catch: () => failure("corrupt", "Encrypted Workspace seed failed authentication"),
      }),
    )
  })

const workspaceSeedAad = (seedId: string) =>
  encoder.encode(JSON.stringify({ kind: "workspace-input-seed", seedId, version: 1 }))

const validObjectKey = (key: string) =>
  key.length > 0 &&
  key.length <= 1_024 &&
  !key.startsWith("/") &&
  key.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")

export const layerWorkspaceSeedVault = (
  options: WorkspaceSeedVaultOptions,
): Layer.Layer<
  WorkspaceSeedVault,
  WorkspaceSeedVaultError,
  Crypto.Crypto | FileSystem.FileSystem | ObjectStore | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    WorkspaceSeedVault,
    Effect.gen(function* () {
      const objects = yield* ObjectStore
      const crypto = yield* Crypto.Crypto
      const fileSystem = yield* FileSystem.FileSystem
      const childProcesses = yield* ChildProcessSpawner.ChildProcessSpawner
      const rawKey = yield* decodeKey(options.encryptionKey)
      const cryptoKey = yield* importKey(rawKey).pipe(Effect.ensuring(Effect.sync(() => rawKey.fill(0))))

      const sha256 = (bytes: Uint8Array) =>
        crypto.digest("SHA-256", bytes).pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(() => failure("crypto", "Workspace seed digest could not be computed")),
        )
      const objectDigest = (bytes: Uint8Array) => sha256(bytes).pipe(Effect.map((digestHex) => `sha256:${digestHex}`))
      const workspaceSeedKey = (seedId: string) =>
        sha256(encoder.encode(seedId)).pipe(
          Effect.map((digestHex) => `${objectNamespace}/${digestHex.slice(0, 32)}/source.archive.aes`),
        )
      const validateSeedId = (seedId: string) =>
        Schema.decodeEffect(WorkspaceSeedId)(seedId).pipe(
          Effect.mapError(() => failure("scope", "Workspace seed identifier is invalid")),
        )
      const validateStored = (stored: StoredArchive) =>
        Schema.decodeEffect(StoredArchive)(stored).pipe(
          Effect.mapError(() => failure("corrupt", "Stored Workspace seed descriptor is invalid")),
        )
      const inspect = (archive: Archive) =>
        inspectArchive(archive).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcesses),
          Effect.mapError((error) =>
            failure(error.kind === "size" ? "size" : "corrupt", "Workspace seed archive is invalid"),
          ),
        )
      const decode = (archive: EncodedArchive) =>
        decodeArchive(archive).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcesses),
        )

      const store: WorkspaceSeedVaultContract["store"] = Effect.fn("WorkspaceSeedVault.store")(
        function* (inputSeedId, encoded) {
          const seedId = yield* validateSeedId(inputSeedId)
          const archive = yield* decode(encoded).pipe(
            Effect.mapError((error) =>
              failure(error.kind === "size" ? "size" : "corrupt", "Workspace seed archive is invalid"),
            ),
          )
          const objectKey = yield* workspaceSeedKey(seedId)
          if (!validObjectKey(objectKey)) return yield* failure("scope", "Workspace seed object key is invalid")
          const nonce = yield* crypto
            .randomBytes(nonceLength)
            .pipe(Effect.mapError(() => failure("crypto", "Workspace seed nonce could not be generated")))
          const encrypted = yield* encrypt(cryptoKey, nonce, workspaceSeedAad(seedId), archive.bytes)
          if (encrypted.byteLength > MaximumEncryptedArchiveBytes)
            return yield* failure("size", "Encrypted Workspace seed exceeds the allowed size")
          yield* objects.put(objectKey, encrypted)
          const remote = yield* objects.get(objectKey)
          if (Option.isNone(remote)) return yield* failure("object", "Workspace seed was not stored")
          if (
            remote.value.byteLength !== encrypted.byteLength ||
            (yield* objectDigest(remote.value)) !== (yield* objectDigest(encrypted))
          )
            return yield* objects
              .remove(objectKey)
              .pipe(Effect.ignore, Effect.andThen(failure("corrupt", "Stored Workspace seed did not verify")))
          const verified = yield* decrypt(cryptoKey, workspaceSeedAad(seedId), remote.value)
          yield* inspect(
            Archive.make({ bytes: verified, contentDigest: archive.contentDigest, sizeBytes: archive.sizeBytes }),
          )
          return StoredArchive.make({
            objectKey,
            contentDigest: yield* objectDigest(remote.value),
            sizeBytes: remote.value.byteLength,
            archiveDigest: archive.contentDigest,
            archiveSizeBytes: archive.sizeBytes,
            encryption: "aes-256-gcm",
          })
        },
      )

      const load: WorkspaceSeedVaultContract["load"] = Effect.fn("WorkspaceSeedVault.load")(
        function* (inputSeedId, inputStored) {
          const seedId = yield* validateSeedId(inputSeedId)
          const stored = yield* validateStored(inputStored)
          const expectedKey = yield* workspaceSeedKey(seedId)
          if (stored.objectKey !== expectedKey || !validObjectKey(stored.objectKey))
            return yield* failure("scope", "Workspace seed does not belong to this scope")
          const remote = yield* objects.get(stored.objectKey)
          if (Option.isNone(remote)) return yield* failure("missing", "Workspace seed is missing")
          if (
            remote.value.byteLength === 0 ||
            remote.value.byteLength > MaximumEncryptedArchiveBytes ||
            remote.value.byteLength !== stored.sizeBytes ||
            (yield* objectDigest(remote.value)) !== stored.contentDigest
          )
            return yield* failure("corrupt", "Stored Workspace seed digest or length is invalid")
          const bytes = yield* decrypt(cryptoKey, workspaceSeedAad(seedId), remote.value)
          if (bytes.byteLength === 0 || bytes.byteLength > MaximumArchiveBytes)
            return yield* failure("size", "Workspace seed archive exceeds the allowed size")
          return yield* inspect(
            Archive.make({
              bytes,
              contentDigest: stored.archiveDigest,
              sizeBytes: stored.archiveSizeBytes,
            }),
          )
        },
      )

      const remove: WorkspaceSeedVaultContract["remove"] = Effect.fn("WorkspaceSeedVault.remove")(
        function* (inputSeedId, inputStored) {
          const seedId = yield* validateSeedId(inputSeedId)
          const stored = yield* validateStored(inputStored)
          const expectedKey = yield* workspaceSeedKey(seedId)
          if (stored.objectKey !== expectedKey || !validObjectKey(stored.objectKey))
            return yield* failure("scope", "Workspace seed does not belong to this scope")
          yield* objects.remove(stored.objectKey)
        },
      )

      return WorkspaceSeedVault.of({ load, remove, store })
    }),
  )

export const layerMemoryObjectStore: Layer.Layer<ObjectStore> = Layer.sync(ObjectStore, () => {
  const objects = new Map<string, Uint8Array>()
  return ObjectStore.of({
    put: (key, value) => Effect.sync(() => void objects.set(key, value.slice())),
    get: (key) => Effect.sync(() => Option.fromNullishOr(objects.get(key)?.slice())),
    remove: (key) => Effect.sync(() => void objects.delete(key)),
  })
})

const isMissingObject = Schema.is(
  Schema.Struct({
    name: Schema.Literals(["NoSuchKey", "NotFound"]),
  }),
)

export const layerS3ObjectStore = (options: S3ObjectStoreOptions): Layer.Layer<ObjectStore, WorkspaceSeedVaultError> =>
  Layer.effect(
    ObjectStore,
    Effect.gen(function* () {
      if (options.bucket.length === 0 || options.region.length === 0)
        return yield* failure("object", "Workspace seed object store configuration is invalid")
      const config: S3ClientConfig = { region: options.region }
      if (options.endpoint !== undefined) config.endpoint = options.endpoint
      if (options.forcePathStyle !== undefined) config.forcePathStyle = options.forcePathStyle
      if (options.credentials !== undefined) {
        const credentials: ResolvedS3Credentials = {
          accessKeyId: Redacted.value(options.credentials.accessKeyId),
          secretAccessKey: Redacted.value(options.credentials.secretAccessKey),
        }
        if (options.credentials.sessionToken !== undefined)
          credentials.sessionToken = Redacted.value(options.credentials.sessionToken)
        config.credentials = credentials
      }
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new S3Client(config)),
        (s3) => Effect.sync(() => s3.destroy()),
      )
      return ObjectStore.of({
        put: (key, value) =>
          Effect.tryPromise({
            try: (signal) =>
              client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: value }), {
                abortSignal: signal,
              }),
            catch: () => failure("object", "Workspace seed object upload failed"),
          }).pipe(Effect.asVoid),
        get: (key) =>
          Effect.tryPromise({
            try: (signal) =>
              client.send(
                new GetObjectCommand({
                  Bucket: options.bucket,
                  Key: key,
                  Range: `bytes=0-${MaximumEncryptedArchiveBytes}`,
                }),
                { abortSignal: signal },
              ),
            catch: (error) =>
              isMissingObject(error)
                ? failure("missing", "Workspace seed object does not exist")
                : failure("object", "Workspace seed object download failed"),
          }).pipe(
            Effect.flatMap((response) => {
              if (response.Body === undefined) return Effect.succeedNone
              if (
                response.ContentLength === undefined ||
                response.ContentLength <= 0 ||
                response.ContentLength > MaximumEncryptedArchiveBytes
              )
                return Effect.fail(failure("size", "Workspace seed object exceeds the allowed size"))
              return Effect.tryPromise({
                try: () => response.Body!.transformToByteArray(),
                catch: () => failure("object", "Workspace seed object download failed"),
              }).pipe(
                Effect.flatMap((bytes) =>
                  bytes.byteLength > MaximumEncryptedArchiveBytes
                    ? Effect.fail(failure("size", "Workspace seed object exceeds the allowed size"))
                    : Effect.succeedSome(new Uint8Array(bytes)),
                ),
              )
            }),
            Effect.catch((error) => (error.kind === "missing" ? Effect.succeedNone : Effect.fail(error))),
          ),
        remove: (key) =>
          Effect.tryPromise({
            try: (signal) =>
              client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal: signal }),
            catch: () => failure("object", "Workspace seed object deletion failed"),
          }).pipe(Effect.asVoid),
      })
    }),
  )
