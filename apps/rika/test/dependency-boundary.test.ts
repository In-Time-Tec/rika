import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

const loadApp = Effect.fn("DependencyBoundary.loadApp")(() =>
  Effect.tryPromise(() => import("@rika/product/product-operation-service")),
)
const loadCommand = Effect.fn("DependencyBoundary.loadCommand")(() =>
  Effect.tryPromise(() => import("../src/command/root/rika-command")),
)

it.effect(
  "loads app and command entrypoints without Bun-only composition",
  () =>
    Effect.gen(function* () {
      const [app, command] = yield* Effect.all([loadApp(), loadCommand()], { concurrency: 2 })

      expect(app.Service).toBeDefined()
      expect(command.command).toBeDefined()
    }),
  15_000,
)
