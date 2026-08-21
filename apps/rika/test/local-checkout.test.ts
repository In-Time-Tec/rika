import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { inspectLocalCheckout } from "../src/local-executor/local-checkout"
import { LocalRunnerRegistration } from "../src/local-executor/local-runner-contract"

const git = Effect.fn("LocalCheckoutTest.git")(function* (cwd: string, arguments_: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("git", arguments_, { cwd, stdout: "ignore", stderr: "ignore" }))
  if (Number(yield* child.exitCode) !== 0) return yield* Effect.die("git failed")
})

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.effect("binds opaque, distinct checkout identities to the authenticated device", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-checkout-" })
      const firstPath = `${root}/first`
      const secondPath = `${root}/second`
      yield* Effect.forEach([firstPath, secondPath], (path) =>
        fileSystem
          .makeDirectory(path)
          .pipe(
            Effect.andThen(git(path, ["init", "--quiet"])),
            Effect.andThen(git(path, ["remote", "add", "origin", "https://user:secret@example.test/owner/repo.git"])),
          ),
      )
      const first = yield* inspectLocalCheckout({
        deviceId: "device-1",
        workspace: firstPath,
        remoteThreadCreation: "denied",
      })
      const second = yield* inspectLocalCheckout({
        deviceId: "device-1",
        workspace: secondPath,
        remoteThreadCreation: "denied",
      })
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(LocalRunnerRegistration))(first.registration)
      expect(first.registration.checkoutFingerprint).not.toBe(second.registration.checkoutFingerprint)
      expect(first.registration.repository.identity).toBe(second.registration.repository.identity)
      expect(first.registration.repository.remoteUrl).toBe("https://example.test/owner/repo.git")
      expect(serialized).not.toContain(root)
      expect(serialized).not.toContain("secret")
      expect(first.workspacePath).toBe(firstPath)
    }),
  ),
)
