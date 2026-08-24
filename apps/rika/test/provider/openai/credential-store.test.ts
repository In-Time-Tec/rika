import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import { expect, test } from "vitest"
import { layer, type Options } from "../../../src/provider/openai/credential-store"

const fixture = {
  formatVersion: 1 as const,
  accessToken: "access",
  idToken: "id",
  refreshToken: "refresh",
  accountId: "account",
  fingerprint: "fingerprint",
  generation: "generation",
  expiresAt: 1,
  refreshedAt: 1,
}
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-openai-store-" })
  return { fileSystem, path, root, parent: path.join(root, "auth"), filename: path.join(root, "auth", "openai.json") }
})
interface TestStore {
  readonly load: Effect.Effect<
    Option.Option<typeof OpenAiAuthContract.CredentialDisk.Type>,
    OpenAiAuthContract.StoreError
  >
  readonly save: (
    credential: typeof OpenAiAuthContract.CredentialDisk.Type,
  ) => Effect.Effect<void, OpenAiAuthContract.StoreError>
  readonly serialized: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OpenAiAuthContract.StoreError, R>
}

const withStore = <A, E>(
  filename: string,
  effect: (store: TestStore) => Effect.Effect<A, E>,
  options: Options = {},
): Effect.Effect<A, E | OpenAiAuthContract.StoreError> =>
  Effect.scoped(
    Layer.build(
      layer(filename, {
        ...(process.getuid === undefined ? {} : { currentUid: process.getuid() }),
        lockTimeout: 80,
        lockRetry: 5,
        ...options,
      }).pipe(Layer.provide(BunServices.layer)),
    ).pipe(
      Effect.flatMap((context) => effect(Context.get(context, OpenAiAuth.Store))),
      Effect.mapError((error) =>
        Option.match(Schema.decodeUnknownOption(OpenAiAuthContract.StoreError)(error), {
          onNone: () => OpenAiAuthContract.StoreError.make({ kind: "io", message: String(error) }),
          onSome: (value) => value,
        }),
      ),
    ),
  )
const errorKind = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onFailure: (failure) =>
      typeof failure === "object" && failure !== null && "kind" in failure ? failure.kind : undefined,
    onSuccess: () => undefined,
  })
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
    ).pipe(Effect.orDie),
  )

test("saves and loads with private modes", () =>
  run(
    Effect.gen(function* () {
      const { fileSystem, parent, filename } = yield* setup
      yield* withStore(filename, (store) => store.serialized(store.save(fixture)))
      const loaded = yield* withStore(filename, (store) => store.load)
      expect(Option.getOrUndefined(loaded)).toEqual(fixture)
      expect((yield* fileSystem.stat(parent)).mode & 0o777).toBe(0o700)
      expect((yield* fileSystem.stat(filename)).mode & 0o777).toBe(0o600)
    }),
  ))

test("rejects symlink credential and symlink parent", () =>
  run(
    Effect.gen(function* () {
      const first = yield* setup
      yield* first.fileSystem.makeDirectory(first.parent, { mode: 0o700 })
      yield* first.fileSystem.symlink(first.path.join(first.root, "missing"), first.filename)
      expect(yield* errorKind(withStore(first.filename, (store) => store.load))).toBe("unsafe")
      const second = yield* setup
      const target = second.path.join(second.root, "target")
      yield* second.fileSystem.makeDirectory(target, { mode: 0o700 })
      yield* second.fileSystem.symlink(target, second.parent)
      expect(yield* errorKind(withStore(second.filename, (store) => store.load))).toBe("unsafe")
      const third = yield* setup
      const outside = third.path.join(third.root, "outside")
      yield* third.fileSystem.makeDirectory(outside, { mode: 0o700 })
      yield* third.fileSystem.symlink(outside, third.parent)
      const nested = third.path.join(third.parent, "profile", "openai.json")
      expect(yield* errorKind(withStore(nested, (store) => store.load, { trustedRoot: third.root }))).toBe("unsafe")
      expect(yield* third.fileSystem.exists(third.path.join(outside, "profile"))).toBe(false)
    }),
  ))

test("rejects a group-writable trusted root", () =>
  run(
    Effect.gen(function* () {
      const { fileSystem, root, filename } = yield* setup
      yield* fileSystem.chmod(root, 0o770)
      expect(yield* errorKind(withStore(filename, (store) => store.load, { trustedRoot: root }))).toBe("unsafe")
    }),
  ))

test("rejects hardlinks, wrong mode, corrupt data, and oversized data", () =>
  run(
    Effect.forEach(["hardlink", "mode", "corrupt", "oversize"] as const, (form) =>
      Effect.gen(function* () {
        const { fileSystem, path, root, parent, filename } = yield* setup
        yield* fileSystem.makeDirectory(parent, { mode: 0o700 })
        let contents: string
        if (form === "oversize") contents = "x".repeat(33)
        else if (form === "corrupt") contents = "{"
        else contents = yield* encodeJson(fixture)
        yield* fileSystem.writeFileString(filename, contents, { mode: 0o600 })
        if (form === "hardlink") yield* fileSystem.link(filename, path.join(root, "copy"))
        if (form === "mode") yield* fileSystem.chmod(filename, 0o644)
        expect(
          yield* errorKind(withStore(filename, (store) => store.load, form === "oversize" ? { maxSize: 32 } : {})),
        ).toBe(form === "corrupt" || form === "oversize" ? "corrupt" : "unsafe")
      }),
    ),
  ))

test("rejects a lock symlink and bounds a live lock wait", () =>
  run(
    Effect.gen(function* () {
      const linked = yield* setup
      yield* linked.fileSystem.makeDirectory(linked.parent, { mode: 0o700 })
      yield* linked.fileSystem.symlink(linked.path.join(linked.root, "missing"), `${linked.filename}.lock`)
      expect(yield* errorKind(withStore(linked.filename, (store) => store.serialized(Effect.void)))).toBe("unsafe")
      const live = yield* setup
      yield* live.fileSystem.makeDirectory(live.parent, { mode: 0o700 })
      const createdAt = yield* Clock.currentTimeMillis
      const lock = yield* encodeJson({ pid: process.pid, nonce: "other", createdAt })
      yield* live.fileSystem.writeFileString(`${live.filename}.lock`, lock, { mode: 0o600 })
      expect(yield* errorKind(withStore(live.filename, (store) => store.serialized(Effect.void)))).toBe("busy")
    }),
  ))

test("fails closed on an abandoned lock and cleans temporary files after failure", () =>
  run(
    Effect.gen(function* () {
      const dead = yield* setup
      yield* dead.fileSystem.makeDirectory(dead.parent, { mode: 0o700 })
      const deadLock = yield* encodeJson({ pid: 2_147_483_647, nonce: "dead", createdAt: 1 })
      yield* dead.fileSystem.writeFileString(`${dead.filename}.lock`, deadLock, { mode: 0o600 })
      expect(yield* errorKind(withStore(dead.filename, (store) => store.serialized(store.save(fixture))))).toBe("busy")
      expect((yield* dead.fileSystem.readDirectory(dead.parent)).some((name) => name.includes(".tmp-"))).toBe(false)
      const unsafe = yield* setup
      yield* unsafe.fileSystem.makeDirectory(unsafe.parent, { mode: 0o700 })
      yield* unsafe.fileSystem.writeFileString(unsafe.filename, "occupied", { mode: 0o644 })
      expect(yield* errorKind(withStore(unsafe.filename, (store) => store.save(fixture)))).toBe("unsafe")
      expect((yield* unsafe.fileSystem.readDirectory(unsafe.parent)).some((name) => name.includes(".tmp-"))).toBe(false)
    }),
  ))

test("independent layers serialize mutations", () =>
  run(
    Effect.gen(function* () {
      const { fileSystem, path, filename } = yield* setup
      let active = 0
      let maximum = 0
      const mutation = Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1
          maximum = Math.max(maximum, active)
        }),
        () => Effect.sleep(30),
        () =>
          Effect.sync(() => {
            active -= 1
          }),
      )
      yield* Effect.all(
        [
          withStore(filename, (store) => store.serialized(mutation)),
          withStore(filename, (store) => store.serialized(mutation)),
        ],
        { concurrency: "unbounded" },
      )
      expect(maximum).toBe(1)
      expect(yield* fileSystem.readDirectory(path.dirname(filename))).not.toContain("openai.json.lock")
    }),
  ))

test("release does not remove a replaced lock", () =>
  run(
    Effect.gen(function* () {
      const { fileSystem, filename } = yield* setup
      const lockname = `${filename}.lock`
      yield* withStore(filename, (store) =>
        store.serialized(
          Effect.gen(function* () {
            yield* fileSystem.remove(lockname)
            const createdAt = yield* Clock.currentTimeMillis
            const replacement = yield* encodeJson({ pid: process.pid, nonce: "replacement", createdAt })
            yield* fileSystem.writeFileString(lockname, replacement, { mode: 0o600 })
          }),
        ),
      )
      expect(yield* fileSystem.stat(lockname)).toBeDefined()
    }),
  ))
