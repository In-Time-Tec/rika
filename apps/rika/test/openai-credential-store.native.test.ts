import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import { afterEach, expect, test } from "bun:test"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { layer, type Options } from "../src/provider/openai/openai-credential-store"

const fs = process.getBuiltinModule("fs").promises
const { tmpdir } = process.getBuiltinModule("os")
const { join } = process.getBuiltinModule("path")
const io = <A>(run: () => Promise<A>) => Effect.promise(run)
const roots: Array<string> = []
afterEach(() =>
  Effect.runPromise(Effect.forEach(roots.splice(0), (root) => io(() => fs.rm(root, { recursive: true, force: true })))),
)
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
  const root = yield* io(() => fs.mkdtemp(join(tmpdir(), "rika-openai-store-")))
  roots.push(root)
  return { root, parent: join(root, "auth"), filename: join(root, "auth", "openai.json") }
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
      }),
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
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect.pipe(Effect.orDie))

test("saves and loads with private modes", () =>
  run(
    Effect.gen(function* () {
      const { parent, filename } = yield* setup
      yield* withStore(filename, (store) => store.serialized(store.save(fixture)))
      const loaded = yield* withStore(filename, (store) => store.load)
      expect(Option.getOrUndefined(loaded)).toEqual(fixture)
      expect((yield* io(() => fs.lstat(parent))).mode & 0o777).toBe(0o700)
      expect((yield* io(() => fs.lstat(filename))).mode & 0o777).toBe(0o600)
    }),
  ))

test("rejects symlink credential and symlink parent", () =>
  run(
    Effect.gen(function* () {
      const first = yield* setup
      yield* io(() => fs.mkdir(first.parent, { mode: 0o700 }))
      yield* io(() => fs.symlink(join(first.root, "missing"), first.filename))
      expect(yield* errorKind(withStore(first.filename, (store) => store.load))).toBe("unsafe")
      const second = yield* setup
      const target = join(second.root, "target")
      yield* io(() => fs.mkdir(target, { mode: 0o700 }))
      yield* io(() => fs.symlink(target, second.parent))
      expect(yield* errorKind(withStore(second.filename, (store) => store.load))).toBe("unsafe")
      const third = yield* setup
      const outside = join(third.root, "outside")
      yield* io(() => fs.mkdir(outside, { mode: 0o700 }))
      yield* io(() => fs.symlink(outside, third.parent))
      const nested = join(third.parent, "profile", "openai.json")
      expect(yield* errorKind(withStore(nested, (store) => store.load, { trustedRoot: third.root }))).toBe("unsafe")
      expect(
        yield* io(() =>
          fs.lstat(join(outside, "profile")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  ))

test("rejects a group-writable trusted root", () =>
  run(
    Effect.gen(function* () {
      const { root, filename } = yield* setup
      yield* io(() => fs.chmod(root, 0o770))
      expect(yield* errorKind(withStore(filename, (store) => store.load, { trustedRoot: root }))).toBe("unsafe")
    }),
  ))

test("rejects hardlinks, wrong mode, corrupt data, and oversized data", () =>
  run(
    Effect.forEach(["hardlink", "mode", "corrupt", "oversize"] as const, (form) =>
      Effect.gen(function* () {
        const { root, parent, filename } = yield* setup
        yield* io(() => fs.mkdir(parent, { mode: 0o700 }))
        let contents: string
        if (form === "oversize") contents = "x".repeat(33)
        else if (form === "corrupt") contents = "{"
        else contents = yield* encodeJson(fixture)
        yield* io(() => fs.writeFile(filename, contents, { mode: 0o600 }))
        if (form === "hardlink") yield* io(() => fs.link(filename, join(root, "copy")))
        if (form === "mode") yield* io(() => fs.chmod(filename, 0o644))
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
      yield* io(() => fs.mkdir(linked.parent, { mode: 0o700 }))
      yield* io(() => fs.symlink(join(linked.root, "missing"), `${linked.filename}.lock`))
      expect(yield* errorKind(withStore(linked.filename, (store) => store.serialized(Effect.void)))).toBe("unsafe")
      const live = yield* setup
      yield* io(() => fs.mkdir(live.parent, { mode: 0o700 }))
      const createdAt = yield* Clock.currentTimeMillis
      const lock = yield* encodeJson({ pid: process.pid, nonce: "other", createdAt })
      yield* io(() => fs.writeFile(`${live.filename}.lock`, lock, { mode: 0o600 }))
      expect(yield* errorKind(withStore(live.filename, (store) => store.serialized(Effect.void)))).toBe("busy")
    }),
  ))

test("fails closed on an abandoned lock and cleans temporary files after failure", () =>
  run(
    Effect.gen(function* () {
      const dead = yield* setup
      yield* io(() => fs.mkdir(dead.parent, { mode: 0o700 }))
      const deadLock = yield* encodeJson({ pid: 2_147_483_647, nonce: "dead", createdAt: 1 })
      yield* io(() => fs.writeFile(`${dead.filename}.lock`, deadLock, { mode: 0o600 }))
      expect(yield* errorKind(withStore(dead.filename, (store) => store.serialized(store.save(fixture))))).toBe("busy")
      expect((yield* io(() => fs.readdir(dead.parent))).some((name) => name.includes(".tmp-"))).toBe(false)
      const unsafe = yield* setup
      yield* io(() => fs.mkdir(unsafe.parent, { mode: 0o700 }))
      yield* io(() => fs.writeFile(unsafe.filename, "occupied", { mode: 0o644 }))
      expect(yield* errorKind(withStore(unsafe.filename, (store) => store.save(fixture)))).toBe("unsafe")
      expect((yield* io(() => fs.readdir(unsafe.parent))).some((name) => name.includes(".tmp-"))).toBe(false)
    }),
  ))

test("independent layers serialize mutations", () =>
  run(
    Effect.gen(function* () {
      const { filename } = yield* setup
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
      expect(yield* io(() => fs.readdir(join(filename, "..")))).not.toContain("openai.json.lock")
    }),
  ))

test("release does not remove a replaced lock", () =>
  run(
    Effect.gen(function* () {
      const { filename } = yield* setup
      const lockname = `${filename}.lock`
      yield* withStore(filename, (store) =>
        store.serialized(
          Effect.gen(function* () {
            yield* io(() => fs.rm(lockname))
            const createdAt = yield* Clock.currentTimeMillis
            const replacement = yield* encodeJson({ pid: process.pid, nonce: "replacement", createdAt })
            yield* io(() => fs.writeFile(lockname, replacement, { mode: 0o600 }))
          }),
        ),
      )
      expect(yield* io(() => fs.lstat(lockname))).toBeDefined()
    }),
  ))
