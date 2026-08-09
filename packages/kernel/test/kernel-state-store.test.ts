import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Function, Layer, Path, Scope } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { make } from "@rika/kernel/kernel-state-store-file-system"

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)

const provide: {
  <R, E2, RIn>(
    layer: Layer.Layer<R, E2, RIn>,
  ): <A, E, RAll>(effect: Effect.Effect<A, E, RAll>) => Effect.Effect<A, E | E2, RIn | Exclude<RAll, R> | Scope.Scope>
  <A, E, RAll, R, E2, RIn>(
    effect: Effect.Effect<A, E, RAll>,
    layer: Layer.Layer<R, E2, RIn>,
  ): Effect.Effect<A, E | E2, RIn | Exclude<RAll, R> | Scope.Scope>
} = Function.dual(2, <A, E, RAll, R, E2, RIn>(effect: Effect.Effect<A, E, RAll>, layer: Layer.Layer<R, E2, RIn>) =>
  Layer.build(layer).pipe(Effect.flatMap((context) => Effect.provideContext(effect, context))),
)

const manifest = (sessionId: string) => ({
  sessionId,
  epoch: 1,
  profileDigest: "digest",
  savedAtMillis: 0,
  restored: [{ name: "total", kind: "value" as const }],
  dropped: [{ name: "helper", reason: "function" as const }],
})

const temporaryRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.makeTempDirectoryScoped()
})

describe("kernel state store", () => {
  it.effect("reports a missing snapshot as undefined rather than a failure", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const store = yield* make(root)
      expect(yield* store.load("absent")).toBeUndefined()
    }).pipe(provide(platform), Effect.scoped),
  )

  it.effect("round-trips a saved namespace with its honest saved and dropped account", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const store = yield* make(root)
      const payload = new TextEncoder().encode("serialized-namespace")
      yield* store.save({ manifest: manifest("session"), payload })
      const loaded = yield* store.load("session")
      expect(loaded?.manifest.sessionId).toBe("session")
      expect(loaded?.manifest.restored).toEqual([{ name: "total", kind: "value" }])
      expect(loaded?.manifest.dropped).toEqual([{ name: "helper", reason: "function" }])
      expect(new TextDecoder().decode(loaded?.payload)).toBe("serialized-namespace")
    }).pipe(provide(platform), Effect.scoped),
  )

  it.effect("keeps one Session's namespace separate from another's", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const store = yield* make(root)
      yield* store.save({ manifest: manifest("a"), payload: new TextEncoder().encode("first") })
      yield* store.save({ manifest: manifest("b"), payload: new TextEncoder().encode("second") })
      expect(new TextDecoder().decode((yield* store.load("a"))?.payload)).toBe("first")
      expect(new TextDecoder().decode((yield* store.load("b"))?.payload)).toBe("second")
    }).pipe(provide(platform), Effect.scoped),
  )

  it.effect("writes owner-only files, because a snapshot is a trusted local artifact", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const path = yield* Path.Path
      const fileSystem = yield* FileSystem.FileSystem
      const store = yield* make(root)
      yield* store.save({ manifest: manifest("session"), payload: new TextEncoder().encode("x") })
      const info = yield* fileSystem.stat(path.join(root, "kernel-state", "session.payload"))
      expect(info.mode & 0o777).toBe(0o600)
    }).pipe(provide(platform), Effect.scoped),
  )

  it.effect("fails typed on a corrupt manifest instead of resetting the Session", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const path = yield* Path.Path
      const fileSystem = yield* FileSystem.FileSystem
      const store = yield* make(root)
      yield* store.save({ manifest: manifest("session"), payload: new TextEncoder().encode("x") })
      yield* fileSystem.writeFileString(path.join(root, "kernel-state", "session.manifest.json"), "{ not json")
      const failure = yield* Effect.flip(store.load("session"))
      expect(failure._tag).toBe("@batonfx/repl/KernelStateUnavailable")
      expect(failure.reason).toBe("corrupt")
    }).pipe(provide(platform), Effect.scoped),
  )

  it.effect("drops a Session's namespace and tolerates dropping one that is absent", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const store = yield* make(root)
      yield* store.save({ manifest: manifest("session"), payload: new TextEncoder().encode("x") })
      yield* store.drop("session")
      expect(yield* store.load("session")).toBeUndefined()
      yield* store.drop("session")
    }).pipe(provide(platform), Effect.scoped),
  )

  it.effect("keys a Session whose id is not a safe file name", () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot
      const store = yield* make(root)
      yield* store.save({ manifest: manifest("thread/../escape"), payload: new TextEncoder().encode("x") })
      const loaded = yield* store.load("thread/../escape")
      expect(loaded?.manifest.sessionId).toBe("thread/../escape")
    }).pipe(provide(platform), Effect.scoped),
  )
})
