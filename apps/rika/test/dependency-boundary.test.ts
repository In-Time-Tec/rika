import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

it.effect("loads app and command entrypoints without Bun-only composition", () =>
  Effect.gen(function* () {
    const [app, command] = yield* Effect.all([
      Effect.promise(() => import("@rika/app")),
      Effect.promise(() => import("../src/command")),
    ])

    expect(app.Operation.Service).toBeDefined()
    expect(command.command).toBeDefined()
  }),
)
