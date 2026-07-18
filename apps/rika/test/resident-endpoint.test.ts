import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Scope } from "effect"
import { resolve } from "../src/resident-endpoint"

const provide = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

describe("resident endpoint ownership", () => {
  it.effect("coalesces profile spelling and data-root aliases into one canonical owner", () =>
    provide(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-resident-endpoint-" })
        const root = `${parent}/root`
        const alias = `${parent}/alias`
        yield* fs.makeDirectory(root)
        yield* fs.symlink(root, alias)

        const [canonical, equivalent] = yield* Effect.all([resolve("default", root), resolve("  DEFAULT  ", alias)])

        expect(equivalent).toEqual(canonical)
      }),
    ),
  )
})
