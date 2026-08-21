import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { processRoleLaunch } from "../src/client/local-role-supervisor"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.effect("starts the TUI controller and local executor as sibling processes", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectory({ prefix: "rika-role-supervisor-" })
      yield* Effect.addFinalizer(() => fileSystem.remove(root, { recursive: true }).pipe(Effect.ignore))
      const fixture = fileURLToPath(new URL("fixtures/local-role.sh", import.meta.url))
      const launch = yield* processRoleLaunch({
        "tui-controller": {
          executable: "/bin/sh",
          arguments: [fixture, "tui-controller"],
          environment: { RIKA_TEST_ROLE_LOG: root },
        },
        "local-executor": {
          executable: "/bin/sh",
          arguments: [fixture, "local-executor"],
          environment: { RIKA_TEST_ROLE_LOG: root },
        },
      })
      const executor = yield* launch.start("local-executor")
      const tui = yield* launch.start("tui-controller")
      expect(yield* Effect.all([executor.exitCode, tui.exitCode], { concurrency: 2 })).toEqual([0, 0])
      for (const event of ["local-executor-started", "tui-controller-started", "tui-controller-exited"])
        expect(yield* fileSystem.exists(`${root}-${event}`)).toBe(true)
    }),
  ),
)
