import { createHash } from "node:crypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import {
  MaximumArchiveBytes,
  decodeArchive,
  inspectArchive,
  type Archive,
  type SetupCacheKey,
} from "@rika/remote-execution/workspace-archive"
import type { EncodedArchive } from "@rika/remote-execution/protocol"
import { Context, Effect, Encoding, FileSystem, Layer, Option, Redacted, Result, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

export interface Inspection {
  readonly contentDigest: string
  readonly sizeBytes: number
}

export class InspectionError extends Schema.TaggedError<InspectionError>()("InspectionError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly inspect: (objectKey: string) => Effect.Effect<Inspection, InspectionError>
}

export class Inspector extends Context.Service<Inspector, Interface>()("@rika/e2b-executor/checkpoint/Inspector") {}

export class CheckpointError extends Schema.TaggedError<CheckpointError>()("CheckpointError", {
  kind: Schema.Literals(["corrupt", "crypto", "missing", "object", "scope", "size"]),
  message: Schema.String,
}) {}

export interface ObjectStoreInterface {
  readonly put: (key: string, value: Uint8Array) => Effect.Effect<void, CheckpointError>
  readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, CheckpointError>
  readonly remove: (key: string) => Effect.Effect<void, CheckpointError>
}

export class ObjectStore extends Context.Service<ObjectStore, ObjectStoreInterface>()(
  "@rika/e2b-executor/checkpoint/ObjectStore",
) {}

export interface CheckpointScope {
  readonly ownerId: string
  readonly threadId: string
  readonly assignmentId: string
  readonly generation: number
  readonly checkpointId: string
}

const MaximumEncryptedArchiveBytes = MaximumArchiveBytes + 1_024

export const StoredArchive = Schema.Struct({
  objectKey: Schema.NonEmptyString,
  contentDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaximumEncryptedArchiveBytes)),
  archiveDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  archiveSizeBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaximumArchiveBytes)),
  encryption: Schema.Literal("aes-256-gcm"),
})
export type StoredArchive = typeof StoredArchive.Type

export interface VaultInterface {
  readonly storeCheckpoint: (
    scope: CheckpointScope,
    archive: EncodedArchive,
  ) => Effect.Effect<StoredArchive, CheckpointError>
  readonly loadCheckpoint: (scope: CheckpointScope, stored: StoredArchive) => Effect.Effect<Archive, CheckpointError>
  readonly storeSetupCache: (
    key: SetupCacheKey,
    archive: EncodedArchive,
  ) => Effect.Effect<StoredArchive, CheckpointError>
  readonly loadSetupCache: (key: SetupCacheKey) => Effect.Effect<Option.Option<Archive>, CheckpointError>
}

export class Vault extends Context.Service<Vault, VaultInterface>()("@rika/e2b-executor/checkpoint/Vault") {}

const failure = (kind: CheckpointError["kind"], message: string) => CheckpointError.make({ kind, message })
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const objectDigest = (value: Uint8Array) => `sha256:${sha256(value)}`
const keyPart = (value: string) => sha256(value).slice(0, 32)
const encoder = new TextEncoder()
const magic = encoder.encode("rika-encrypted-workspace-v1\n")
const nonceLength = 12

const validObjectKey = (key: string) =>
  key.length > 0 &&
  key.length <= 1_024 &&
  !key.startsWith("/") &&
  key.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")

const isMissingObject = Schema.is(Schema.Struct({ name: Schema.Literal("NoSuchKey") }))

const checkpointPrefix = (scope: CheckpointScope) =>
  `owners/${keyPart(scope.ownerId)}/threads/${keyPart(scope.threadId)}/assignments/${keyPart(scope.assignmentId)}/g${scope.generation}/`

const checkpointKey = (scope: CheckpointScope) => `${checkpointPrefix(scope)}${keyPart(scope.checkpointId)}.tar.zst.aes`

const cacheScope = (key: SetupCacheKey) => ({
  kind: "setup-cache" as const,
  ownerId: key.ownerId,
  repositoryId: key.repository.repositoryId,
  commitSha: key.repository.commitSha,
  setupHookDigest: key.setupHookDigest,
  templateBuildId: key.templateBuildId,
  environmentDigest: key.environmentDigest,
})

const cacheKey = (key: SetupCacheKey) => {
  const scope = cacheScope(key)
  return `owners/${keyPart(key.ownerId)}/setup-cache/${sha256(JSON.stringify(scope))}.tar.zst.aes`
}

const checkpointAad = (scope: CheckpointScope) =>
  encoder.encode(
    JSON.stringify({
      kind: "checkpoint",
      ownerId: scope.ownerId,
      threadId: scope.threadId,
      assignmentId: scope.assignmentId,
      generation: scope.generation,
      checkpointId: scope.checkpointId,
    }),
  )

const cacheAad = (key: SetupCacheKey) => encoder.encode(JSON.stringify(cacheScope(key)))

const decodeKey = (key: Redacted.Redacted<string>) =>
  Result.match(Encoding.decodeBase64(Redacted.value(key)), {
    onFailure: () => Effect.fail(failure("crypto", "Workspace encryption key is invalid")),
    onSuccess: (bytes) =>
      bytes.byteLength === 32
        ? Effect.succeed(bytes)
        : Effect.fail(failure("crypto", "Workspace encryption key must contain 32 bytes")),
  })

const importKey = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: () => failure("crypto", "Workspace encryption key could not be loaded"),
  })

const encrypt = (key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
    catch: () => failure("crypto", "Workspace archive encryption failed"),
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
      encrypted.byteLength <= magic.byteLength + nonceLength + 16 ||
      !magic.every((value, index) => encrypted[index] === value)
    )
      return yield* failure("corrupt", "Encrypted Workspace archive header is invalid")
    const nonce = encrypted.slice(magic.byteLength, magic.byteLength + nonceLength)
    const ciphertext = encrypted.slice(magic.byteLength + nonceLength)
    return new Uint8Array(
      yield* Effect.tryPromise({
        try: () =>
          globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ciphertext),
        catch: () => failure("corrupt", "Encrypted Workspace archive failed authentication"),
      }),
    )
  })

export const vaultLayer = (
  masterKey: Redacted.Redacted<string>,
): Layer.Layer<Vault, CheckpointError, FileSystem.FileSystem | ObjectStore> =>
  Layer.effect(
    Vault,
    Effect.gen(function* () {
      const objects = yield* ObjectStore
      const fileSystem = yield* FileSystem.FileSystem
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const cryptoKey = yield* importKey(yield* decodeKey(masterKey))
      const decode = (archive: EncodedArchive) =>
        decodeArchive(archive).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        )
      const inspect = (archive: Archive) =>
        inspectArchive(archive).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        )

      const store = Effect.fn("CheckpointVault.store")(function* (
        objectKey: string,
        aad: Uint8Array,
        encoded: EncodedArchive,
      ) {
        const archive = yield* decode(encoded).pipe(
          Effect.mapError((error) => failure(error.kind === "size" ? "size" : "corrupt", error.message)),
        )
        if (!validObjectKey(objectKey)) return yield* failure("scope", "Workspace object key is invalid")
        const nonce = yield* Effect.sync(() => globalThis.crypto.getRandomValues(new Uint8Array(nonceLength)))
        const encrypted = yield* encrypt(cryptoKey, nonce, aad, archive.bytes)
        if (encrypted.byteLength > MaximumEncryptedArchiveBytes)
          return yield* failure("size", "Encrypted Workspace archive exceeds the allowed size")
        yield* objects.put(objectKey, encrypted)
        const remote = yield* objects.get(objectKey)
        if (Option.isNone(remote)) return yield* failure("object", "Workspace archive was not stored")
        if (remote.value.byteLength !== encrypted.byteLength || objectDigest(remote.value) !== objectDigest(encrypted))
          return yield* objects
            .remove(objectKey)
            .pipe(Effect.ignore, Effect.andThen(failure("corrupt", "Stored Workspace archive did not verify")))
        const verified = yield* decrypt(cryptoKey, aad, remote.value)
        yield* inspect({
          bytes: verified,
          contentDigest: archive.contentDigest,
          sizeBytes: archive.sizeBytes,
        }).pipe(Effect.mapError((error) => failure("corrupt", error.message)))
        return {
          objectKey,
          contentDigest: objectDigest(remote.value),
          sizeBytes: remote.value.byteLength,
          archiveDigest: archive.contentDigest,
          archiveSizeBytes: archive.sizeBytes,
          encryption: "aes-256-gcm" as const,
        }
      })

      const load = Effect.fn("CheckpointVault.load")(function* (
        objectKey: string,
        expectedPrefix: string,
        aad: Uint8Array,
        stored: StoredArchive,
      ) {
        if (objectKey !== stored.objectKey || !objectKey.startsWith(expectedPrefix) || !validObjectKey(objectKey))
          return yield* failure("scope", "Workspace archive does not belong to this scope")
        const remote = yield* objects.get(objectKey)
        if (Option.isNone(remote)) return yield* failure("missing", "Workspace archive is missing")
        if (remote.value.byteLength !== stored.sizeBytes || objectDigest(remote.value) !== stored.contentDigest)
          return yield* failure("corrupt", "Stored Workspace archive digest or length is invalid")
        const bytes = yield* decrypt(cryptoKey, aad, remote.value)
        return yield* inspect({
          bytes,
          contentDigest: stored.archiveDigest,
          sizeBytes: stored.archiveSizeBytes,
        }).pipe(Effect.mapError((error) => failure("corrupt", error.message)))
      })

      const storeCheckpoint: VaultInterface["storeCheckpoint"] = (scope, archive) =>
        store(checkpointKey(scope), checkpointAad(scope), archive)
      const loadCheckpoint: VaultInterface["loadCheckpoint"] = (scope, stored) =>
        load(stored.objectKey, checkpointPrefix(scope), checkpointAad(scope), stored)
      const storeSetupCache: VaultInterface["storeSetupCache"] = (key, archive) =>
        store(cacheKey(key), cacheAad(key), archive)
      const loadSetupCache: VaultInterface["loadSetupCache"] = (key) => {
        const objectKey = cacheKey(key)
        return objects.get(objectKey).pipe(
          Effect.flatMap((remote) => {
            if (Option.isNone(remote)) return Effect.succeedNone
            if (remote.value.byteLength === 0 || remote.value.byteLength > MaximumEncryptedArchiveBytes)
              return objects.remove(objectKey).pipe(Effect.ignore, Effect.as(Option.none()))
            return decrypt(cryptoKey, cacheAad(key), remote.value).pipe(
              Effect.flatMap((bytes) =>
                inspect({ bytes, contentDigest: objectDigest(bytes), sizeBytes: bytes.byteLength }),
              ),
              Effect.map(Option.some),
              Effect.catch(() => objects.remove(objectKey).pipe(Effect.ignore, Effect.as(Option.none()))),
            )
          }),
          Effect.catch(() => Effect.succeedNone),
        )
      }

      return Vault.of({ storeCheckpoint, loadCheckpoint, storeSetupCache, loadSetupCache })
    }),
  ).pipe(Layer.provide(BunServices.layer))

export const memoryObjectStore = (): ObjectStoreInterface => {
  const objects = new Map<string, Uint8Array>()
  return ObjectStore.of({
    put: (key, value) => Effect.sync(() => void objects.set(key, value.slice())),
    get: (key) => Effect.sync(() => Option.fromNullishOr(objects.get(key)?.slice())),
    remove: (key) => Effect.sync(() => void objects.delete(key)),
  })
}

export interface S3Options {
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
}

export const s3ObjectStoreLayer = (options: S3Options): Layer.Layer<ObjectStore> => {
  const config: S3ClientConfig = { region: options.region }
  if (options.endpoint !== undefined) {
    config.endpoint = options.endpoint
    config.forcePathStyle = true
  }
  const client = new S3Client(config)
  return Layer.succeed(
    ObjectStore,
    ObjectStore.of({
      put: (key, value) =>
        Effect.tryPromise({
          try: () => client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: value })),
          catch: () => failure("object", "Workspace object upload failed"),
        }).pipe(Effect.asVoid),
      get: (key) =>
        Effect.tryPromise({
          try: () => client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key })),
          catch: (error) =>
            isMissingObject(error)
              ? failure("missing", "Workspace object does not exist")
              : failure("object", "Workspace object download failed"),
        }).pipe(
          Effect.flatMap((response) =>
            response.Body === undefined
              ? Effect.succeedNone
              : Effect.tryPromise({
                  try: () => response.Body!.transformToByteArray(),
                  catch: () => failure("object", "Workspace object download failed"),
                }).pipe(Effect.map((bytes) => Option.some(new Uint8Array(bytes)))),
          ),
          Effect.catch((error) =>
            error.kind === "missing" ? Effect.succeedNone : Effect.fail(failure("object", error.message)),
          ),
        ),
      remove: (key) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })),
          catch: () => failure("object", "Workspace object deletion failed"),
        }).pipe(Effect.asVoid),
    }),
  )
}
