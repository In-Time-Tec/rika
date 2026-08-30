import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { createArchive, encodeArchive, MaximumArchiveBytes } from "@rika/remote-execution/workspace-archive"
import {
  CheckpointError,
  ObjectStore,
  StoredArchive,
  Vault,
  type ObjectStoreInterface,
  vaultLayer,
} from "../src/checkpoint"

const key = Redacted.make(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
const scope = {
  ownerId: "owner-1",
  threadId: "thread-1",
  assignmentId: "assignment-1",
  generation: 1,
  checkpointId: "checkpoint-1",
}
const cacheKey = {
  ownerId: "owner-1",
  repository: {
    repositoryId: "repository-1",
    owner: "In-Time-Tec",
    name: "rika",
    commitSha: "a".repeat(40),
  },
  setupHookDigest: `sha256:${"b".repeat(64)}`,
  templateBuildId: "build-1",
  environmentDigest: `sha256:${"c".repeat(64)}`,
}

const withVault = <A, E>(
  effect: Effect.Effect<A, E, Vault | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>,
  objects: ObjectStoreInterface,
) =>
  Effect.scoped(
    Layer.build(
      Layer.merge(
        BunServices.layer,
        vaultLayer(key).pipe(Layer.provide(Layer.succeed(ObjectStore, objects)), Layer.provide(BunServices.layer)),
      ),
    ).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
  )

const workspaceArchive = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const directory = yield* fileSystem.makeTempDirectory({ prefix: "rika-vault-test-" })
  return yield* Effect.gen(function* () {
    yield* fileSystem.writeFileString(`${directory}/state.txt`, "durable workspace state")
    return encodeArchive(yield* createArchive(directory))
  }).pipe(Effect.ensuring(fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)))
})

describe("Workspace checkpoint vault", () => {
  it.effect("encrypts Workspace seeds in their own scope and removes only the matching seed", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = ObjectStore.of({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) => Effect.sync(() => Option.fromNullishOr(durable.get(objectKey)?.slice())),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* Vault
        const archive = yield* workspaceArchive
        const stored = yield* vault.storeWorkspaceSeed("seed-1", archive)
        expect(stored.objectKey).toMatch(/^workspace-seeds\/[a-f0-9]{32}\/source\.tar\.zst\.aes$/)
        expect(new TextDecoder().decode(durable.get(stored.objectKey))).not.toContain("durable workspace state")
        expect((yield* vault.loadWorkspaceSeed("seed-1", stored)).bytes).toEqual(
          (yield* createArchiveFromEncoded(archive)).bytes,
        )
        expect((yield* Effect.flip(vault.loadWorkspaceSeed("seed-2", stored))).kind).toBe("scope")
        expect((yield* Effect.flip(vault.removeWorkspaceSeed("seed-2", stored))).kind).toBe("scope")
        yield* vault.removeWorkspaceSeed("seed-1", stored)
        expect(durable.size).toBe(0)
      }),
      objects,
    )
  })

  it.effect("encrypts owner and Thread-bound archives and verifies their durable metadata", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = ObjectStore.of({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) => Effect.sync(() => Option.fromNullishOr(durable.get(objectKey)?.slice())),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* Vault
        const archive = yield* workspaceArchive
        const stored = yield* vault.storeCheckpoint(scope, archive)
        expect(stored.objectKey).toMatch(/^owners\/[a-f0-9]{32}\/threads\/[a-f0-9]{32}\//)
        expect(new TextDecoder().decode(durable.get(stored.objectKey))).not.toContain("durable workspace state")
        expect((yield* vault.loadCheckpoint(scope, stored)).bytes).toEqual(
          (yield* createArchiveFromEncoded(archive)).bytes,
        )
        expect((yield* Effect.flip(vault.loadCheckpoint({ ...scope, ownerId: "owner-2" }, stored))).kind).toBe("scope")
        expect(
          (yield* Effect.flip(vault.loadCheckpoint(scope, { ...stored, sizeBytes: stored.sizeBytes + 1 }))).kind,
        ).toBe("corrupt")
        expect(Schema.is(StoredArchive)({ ...stored, sizeBytes: MaximumArchiveBytes + 1_025 })).toBe(false)
        expect(Schema.is(StoredArchive)({ ...stored, archiveSizeBytes: MaximumArchiveBytes + 1 })).toBe(false)
      }),
      objects,
    )
  })

  it.effect("isolates setup caches by every authority and environment key component", () => {
    const durable = new Map<string, Uint8Array>()
    const objects = ObjectStore.of({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) => Effect.sync(() => Option.fromNullishOr(durable.get(objectKey)?.slice())),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* Vault
        const archive = yield* workspaceArchive
        yield* vault.storeSetupCache(cacheKey, archive)
        expect(Option.isSome(yield* vault.loadSetupCache(cacheKey))).toBe(true)
        for (const mismatched of [
          { ...cacheKey, ownerId: "owner-2" },
          { ...cacheKey, repository: { ...cacheKey.repository, repositoryId: "repository-2" } },
          { ...cacheKey, repository: { ...cacheKey.repository, commitSha: "d".repeat(40) } },
          { ...cacheKey, setupHookDigest: `sha256:${"d".repeat(64)}` },
          { ...cacheKey, templateBuildId: "build-2" },
          { ...cacheKey, environmentDigest: `sha256:${"d".repeat(64)}` },
        ])
          expect(Option.isNone(yield* vault.loadSetupCache(mismatched))).toBe(true)
      }),
      objects,
    )
  })

  it.effect("rejects an upload that does not verify and treats a corrupt setup cache as a safe miss", () => {
    const durable = new Map<string, Uint8Array>()
    let corruptRead = true
    let readFailure = false
    const objects = ObjectStore.of({
      put: (objectKey, value) => Effect.sync(() => void durable.set(objectKey, value.slice())),
      get: (objectKey) =>
        readFailure
          ? Effect.fail(CheckpointError.make({ kind: "object", message: "cache storage unavailable" }))
          : Effect.sync(() => {
              const value = durable.get(objectKey)?.slice()
              if (value === undefined) return Option.none<Uint8Array>()
              if (corruptRead) value.set([value.at(-1)! ^ 1], value.length - 1)
              return Option.some(value)
            }),
      remove: (objectKey) => Effect.sync(() => void durable.delete(objectKey)),
    })
    return withVault(
      Effect.gen(function* () {
        const vault = yield* Vault
        const archive = yield* workspaceArchive
        expect((yield* Effect.flip(vault.storeCheckpoint(scope, archive))).kind).toBe("corrupt")
        corruptRead = false
        yield* vault.storeSetupCache(cacheKey, archive)
        corruptRead = true
        expect(Option.isNone(yield* vault.loadSetupCache(cacheKey))).toBe(true)
        expect(durable.size).toBe(0)
        readFailure = true
        expect(Option.isNone(yield* vault.loadSetupCache(cacheKey))).toBe(true)
      }),
      objects,
    )
  })
})

const createArchiveFromEncoded = (archive: {
  readonly content: string
  readonly contentDigest: string
  readonly sizeBytes: number
}) =>
  Effect.succeed({
    bytes: new Uint8Array(Buffer.from(archive.content, "base64")),
    contentDigest: archive.contentDigest,
    sizeBytes: archive.sizeBytes,
  })
