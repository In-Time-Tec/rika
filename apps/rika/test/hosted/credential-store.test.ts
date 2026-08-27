import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import { CredentialStore, type PrivateJwk } from "../../src/hosted/contract"
import { layer as credentialLayer } from "../../src/hosted/credential-store"

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)
const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const origin = "https://hosted.example.test"
const deviceId = "device-1"
const credential = { refreshToken: Redacted.make("refresh-secret"), privateJwk: key }

it.layer(platform)((test) => {
  test.effect("persists one owner-only hosted credential across store instances", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-credential-" })
        const filename = path.join(root, "hosted-credential.json")
        const options = { filename, lockPath: path.join(root, "hosted-refresh.lock") }
        const first = Context.get(yield* Layer.build(credentialLayer(options)), CredentialStore)
        const second = Context.get(yield* Layer.build(credentialLayer(options)), CredentialStore)

        expect(yield* first.load(origin, deviceId)).toEqual(Option.none())
        yield* first.save(origin, deviceId, credential)
        expect(Redacted.value(Option.getOrThrow(yield* second.load(origin, deviceId)).refreshToken)).toBe(
          "refresh-secret",
        )
        expect(yield* second.load(origin, "another-device")).toEqual(Option.none())
        expect(yield* second.load("https://another.example.test", deviceId)).toEqual(Option.none())
        expect((yield* fileSystem.stat(root)).mode & 0o777).toBe(0o700)
        expect((yield* fileSystem.stat(filename)).mode & 0o777).toBe(0o600)
        const persisted = yield* fileSystem
          .readFileString(filename)
          .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))))
        expect(persisted).toEqual({
          formatVersion: 1,
          origin,
          deviceId,
          refreshToken: "refresh-secret",
          privateJwk: key,
        })
        expect(yield* second.remove(origin, "another-device")).toBe(false)
        expect(yield* second.remove(origin, deviceId)).toBe(true)
        expect(yield* first.load(origin, deviceId)).toEqual(Option.none())
      }),
    ),
  )

  test.effect("fails closed for corrupt, exposed, and symbolic-link credential files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-credential-invalid-" })
        const filename = path.join(root, "hosted-credential.json")
        const store = Context.get(
          yield* Layer.build(credentialLayer({ filename, lockPath: path.join(root, "hosted-refresh.lock") })),
          CredentialStore,
        )

        yield* fileSystem.writeFileString(filename, "not-json", { mode: 0o600 })
        expect((yield* Effect.flip(store.load(origin, deviceId))).message).toContain("corrupt")
        yield* fileSystem.writeFileString(filename, "{}", { mode: 0o644 })
        yield* fileSystem.chmod(filename, 0o644)
        expect((yield* Effect.flip(store.load(origin, deviceId))).message).toContain("permissions must be 0600")
        yield* fileSystem.remove(filename)
        const outside = path.join(root, "outside.json")
        yield* fileSystem.writeFileString(outside, "{}", { mode: 0o600 })
        yield* fileSystem.symlink(outside, filename)
        expect((yield* Effect.flip(store.load(origin, deviceId))).message).toContain("symbolic link")
      }),
    ),
  )

  test.effect("secures an existing private configuration directory before saving", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-credential-mode-" })
        const directory = path.join(root, "rika")
        const filename = path.join(directory, "hosted-credential.json")
        yield* fileSystem.makeDirectory(directory, { mode: 0o755 })
        const store = Context.get(
          yield* Layer.build(credentialLayer({ filename, lockPath: path.join(directory, "hosted-refresh.lock") })),
          CredentialStore,
        )
        expect(yield* store.load(origin, deviceId)).toEqual(Option.none())
        yield* store.save(origin, deviceId, credential)
        expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700)
      }),
    ),
  )
})
