import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { make } from "../../src/runner/preference"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.effect("defaults to denied and scopes revocable admission to device plus checkout", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-admission-" })
      const path = `${root}/config/admission.json`
      const store = yield* make(path)
      expect(yield* store.get("device-a", "checkout-a")).toBe("denied")
      yield* store.set("device-a", "checkout-a", "allowed")
      expect(yield* store.get("device-a", "checkout-a")).toBe("allowed")
      expect(yield* store.get("device-b", "checkout-a")).toBe("denied")
      expect(yield* store.get("device-a", "checkout-b")).toBe("denied")
      yield* store.set("device-a", "checkout-a", "denied")
      expect(yield* store.get("device-a", "checkout-a")).toBe("denied")
      expect((yield* fileSystem.stat(path)).mode & 0o077).toBe(0)
    }),
  ),
)
