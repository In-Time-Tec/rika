import { expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import type { ForegroundRunnerSnapshot } from "@rika/remote-execution/foreground"
import { makeRunnerReceiptStore } from "../src/runner/runner-receipt-store"
import type { SecretVault } from "../src/hosted/hosted-credential-store"

const vault = (values: Map<string, string>): SecretVault => ({
  get: ({ service, name }) => Effect.runPromise(Effect.succeed(values.get(`${service}:${name}`) ?? null)),
  set: ({ service, name, value }) =>
    Effect.runPromise(
      Effect.sync(() => {
        values.set(`${service}:${name}`, value)
      }),
    ),
  delete: ({ service, name }) => Effect.runPromise(Effect.sync(() => values.delete(`${service}:${name}`))),
})

const snapshot: ForegroundRunnerSnapshot = {
  version: 1,
  workspaceIdentity: "workspace-1",
  executorUrl: "wss://hosted.example.test/api/v1/runners",
  access: {
    version: 1,
    fence: {
      target: "runner",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      instanceId: "device-1",
      executorId: "executor-1",
      processIncarnation: "process-1",
    },
    leaseEpoch: 2,
    sessionToken: "session-secret",
  },
  leaseExpiresAt: 2_000_000_000_000,
  heartbeatIntervalMillis: 20_000,
  cursor: { sequence: 3, value: "cursor-3" },
  receipts: [],
  cells: [],
  machines: [],
}

it.effect("stores Runner recovery state in the platform vault by assignment", () =>
  Effect.gen(function* () {
    const values = new Map<string, string>()
    const store = makeRunnerReceiptStore({
      origin: "https://hosted.example.test/path",
      deviceId: "device-1",
      vault: vault(values),
    })
    yield* store.save("assignment-1", snapshot)
    expect(Option.getOrThrow(yield* store.load("assignment-1"))).toEqual(snapshot)
    expect(yield* store.load("assignment-2")).toEqual(Option.none())
    yield* store.remove("assignment-1")
    expect(yield* store.load("assignment-1")).toEqual(Option.none())
  }),
)
