import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { createArchive, decodeArchive, encodeArchive } from "../src/archive"
import { MaximumArchiveBytes, MaximumEncryptedArchiveBytes, StoredArchive } from "../src/contract"
import {
  ObjectStore,
  WorkspaceSeedVault,
  WorkspaceSeedVaultError,
  layerMemoryObjectStore,
  layerWorkspaceSeedVault,
  type ObjectStoreContract,
} from "../src/vault"

const key = Redacted.make(Encoding.encodeBase64(new Uint8Array(32).fill(7)))

const withVault = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    WorkspaceSeedVault | Crypto.Crypto | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >,
  objectStore: Layer.Layer<ObjectStore>,
) =>
  Effect.scoped(
    Layer.build(
      Layer.merge(
        BunServices.layer,
        layerWorkspaceSeedVault({ encryptionKey: key }).pipe(
          Layer.provide(objectStore),
          Layer.provide(BunServices.layer),
        ),
      ),
    ).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
  )

const workspaceArchive = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const directory = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-seed-vault-" })
  return yield* Effect.gen(function* () {
    yield* fileSystem.writeFileString(`${directory}/state.txt`, "durable workspace state")
    return encodeArchive(yield* createArchive(directory))
  }).pipe(Effect.ensuring(fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)))
})

const layerFrom = (objects: ObjectStoreContract) => Layer.succeed(ObjectStore, ObjectStore.of(objects))

describe("Workspace seed vault", () => {
  it.effect("encrypts seeds in the fresh namespace and removes only the matching seed", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = layerFrom({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) => Effect.sync(() => Option.fromNullishOr(durable.get(objectKey)?.slice())),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* WorkspaceSeedVault
        const archive = yield* workspaceArchive
        const stored = yield* vault.store("seed-1", archive)
        expect(stored.objectKey).toMatch(/^workspace-input\/v1\/workspace-seeds\/[a-f0-9]{32}\/source\.archive\.aes$/)
        const encrypted = durable.get(stored.objectKey)!
        expect(new TextDecoder().decode(encrypted)).not.toContain("durable workspace state")
        expect(new TextDecoder().decode(encrypted.slice(0, 29))).toBe("rika-workspace-input-seed-v1\n")
        expect((yield* vault.load("seed-1", stored)).bytes).toEqual((yield* decodeArchive(archive)).bytes)
        expect((yield* Effect.flip(vault.load("seed-2", stored))).kind).toBe("scope")
        expect((yield* Effect.flip(vault.remove("seed-2", stored))).kind).toBe("scope")
        yield* vault.remove("seed-1", stored)
        expect(durable.size).toBe(0)
      }),
      objects,
    )
  })

  it.effect("offers an isolated memory ObjectStore layer", () =>
    withVault(
      Effect.gen(function* () {
        const vault = yield* WorkspaceSeedVault
        const archive = yield* workspaceArchive
        const stored = yield* vault.store("memory-seed", archive)
        expect((yield* vault.load("memory-seed", stored)).contentDigest).toBe(archive.contentDigest)
        yield* vault.remove("memory-seed", stored)
        expect((yield* Effect.flip(vault.load("memory-seed", stored))).kind).toBe("missing")
      }),
      layerMemoryObjectStore,
    ),
  )

  it.effect("authenticates the seed scope with AAD and rejects the retired encryption header", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = layerFrom({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) => Effect.sync(() => Option.fromNullishOr(durable.get(objectKey)?.slice())),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* WorkspaceSeedVault
        const crypto = yield* Crypto.Crypto
        const archive = yield* workspaceArchive
        const first = yield* vault.store("seed-a", archive)
        const second = yield* vault.store("seed-b", archive)
        const firstBytes = durable.get(first.objectKey)!.slice()
        durable.set(second.objectKey, firstBytes)
        const firstDigest = `sha256:${Encoding.encodeHex(yield* crypto.digest("SHA-256", firstBytes))}`
        expect(
          (yield* Effect.flip(
            vault.load("seed-b", { ...second, contentDigest: firstDigest, sizeBytes: firstBytes.byteLength }),
          )).kind,
        ).toBe("corrupt")

        const retired = firstBytes.slice()
        retired.set(new TextEncoder().encode("rika-encrypted-workspace-v1\n"), 0)
        durable.set(first.objectKey, retired)
        const retiredDigest = `sha256:${Encoding.encodeHex(yield* crypto.digest("SHA-256", retired))}`
        expect(
          (yield* Effect.flip(
            vault.load("seed-a", { ...first, contentDigest: retiredDigest, sizeBytes: retired.byteLength }),
          )).kind,
        ).toBe("corrupt")
      }),
      objects,
    )
  })

  it.effect("verifies durable metadata and schema bounds on every load", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = layerFrom({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) => Effect.sync(() => Option.fromNullishOr(durable.get(objectKey)?.slice())),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* WorkspaceSeedVault
        const stored = yield* vault.store("bounded-seed", yield* workspaceArchive)
        expect(
          (yield* Effect.flip(vault.load("bounded-seed", { ...stored, sizeBytes: stored.sizeBytes + 1 }))).kind,
        ).toBe("corrupt")
        expect(
          (yield* Effect.flip(vault.load("bounded-seed", { ...stored, archiveDigest: `sha256:${"0".repeat(64)}` })))
            .kind,
        ).toBe("corrupt")
        expect(Schema.is(StoredArchive)({ ...stored, sizeBytes: MaximumEncryptedArchiveBytes + 1 })).toBe(false)
        expect(Schema.is(StoredArchive)({ ...stored, archiveSizeBytes: MaximumArchiveBytes + 1 })).toBe(false)
      }),
      objects,
    )
  })

  it.effect("deletes an upload that does not verify", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = layerFrom({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) =>
        Effect.sync(() => {
          const value = durable.get(objectKey)?.slice()
          if (value === undefined) return Option.none<Uint8Array>()
          value.set([value.at(-1)! ^ 1], value.length - 1)
          return Option.some(value)
        }),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* WorkspaceSeedVault
        expect((yield* Effect.flip(vault.store("corrupt-seed", yield* workspaceArchive))).kind).toBe("corrupt")
        expect(durable.size).toBe(0)
      }),
      objects,
    )
  })

  it.effect("redacts key and malformed archive material from failures", () => {
    const privateKey = "private-workspace-encryption-key"
    const invalidKeyLayer = layerWorkspaceSeedVault({ encryptionKey: Redacted.make(privateKey) }).pipe(
      Layer.provide(layerMemoryObjectStore),
      Layer.provide(BunServices.layer),
    )
    return Effect.scoped(
      Effect.gen(function* () {
        const exit = yield* Layer.build(invalidKeyLayer).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).not.toContain(privateKey)

        const writes: Array<string> = []
        const objects = layerFrom({
          put: (objectKey) => Effect.sync(() => void writes.push(objectKey)),
          get: () => Effect.succeedNone,
          remove: () => Effect.void,
        })
        yield* withVault(
          Effect.gen(function* () {
            const vault = yield* WorkspaceSeedVault
            const secret = "private-encoded-workspace-material"
            const error = yield* Effect.flip(
              vault.store("safe-id", {
                content: `invalid-${secret}`,
                contentDigest: `sha256:${"0".repeat(64)}`,
                sizeBytes: 1,
              }),
            )
            expect(error).toBeInstanceOf(WorkspaceSeedVaultError)
            expect(error.message).not.toContain(secret)
            expect(writes).toEqual([])
          }),
          objects,
        )
      }),
    )
  })
})
