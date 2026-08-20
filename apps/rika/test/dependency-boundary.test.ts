import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

const loadClient = Effect.fn("DependencyBoundary.loadClient")(() => Effect.tryPromise(() => import("../src/client/client-process")))
const loadCommand = Effect.fn("DependencyBoundary.loadCommand")(() =>
  Effect.tryPromise(() => import("../src/command/root/rika-command")),
)

it.effect(
  "loads only the hosted client composition",
  () =>
    Effect.gen(function* () {
      const [client, command] = yield* Effect.all([loadClient(), loadCommand()], { concurrency: 2 })
      expect(client.run).toBeDefined()
      expect(command.command).toBeDefined()
    }),
  15_000,
)
