import { Context, Effect, Layer, Option } from "effect"
import { expect, it } from "@effect/vitest"
import { ForegroundLocalExecutorSnapshot } from "@rika/remote-execution/foreground"
import { receiptLayer, type SecretVault } from "../src/hosted/hosted-credential-store"
import { LocalExecutorReceiptStore } from "../src/hosted/hosted-contract"

const snapshot: ForegroundLocalExecutorSnapshot = {
  version: 1,
  workspaceIdentity: "workspace-1",
  executorUrl: "wss://hosted.example.test/api/v1/local-executors",
  access: {
    version: 1,
    fence: {
      target: "local_device",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      instanceId: "instance-1",
      executorId: "executor-1",
      processIncarnation: "process-1",
    },
    leaseEpoch: 1,
    sessionToken: "session-1",
  },
  leaseExpiresAt: 1_800_000_000_000,
  heartbeatIntervalMillis: 5_000,
  cursor: { sequence: 0, value: "" },
  receipts: [],
}

it.effect("persists local executor receipts through the platform vault", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const values = new Map<string, string>()
      const calls: Array<string> = []
      const vault: SecretVault = {
        get: ({ service, name }) => {
          calls.push(`get:${service}:${name}`)
          return Promise.resolve(values.get(`${service}:${name}`) ?? null)
        },
        set: ({ service, name, value }) => {
          calls.push(`set:${service}:${name}`)
          values.set(`${service}:${name}`, value)
          return Promise.resolve()
        },
        delete: ({ service, name }) => {
          calls.push(`delete:${service}:${name}`)
          return Promise.resolve(values.delete(`${service}:${name}`))
        },
      }
      const context = yield* Layer.build(receiptLayer(vault))
      const store = Context.get(context, LocalExecutorReceiptStore)
      const scope = "https://hosted.example.test/device-1/thread-1"

      yield* store.save(scope, snapshot)
      expect(yield* store.load(scope)).toEqual(Option.some(snapshot))
      expect(yield* store.remove(scope)).toBe(true)
      expect(yield* store.load(scope)).toEqual(Option.none())
      expect(calls).toEqual([
        "set:com.rika.cli.local-executor:https://hosted.example.test/device-1/thread-1",
        "get:com.rika.cli.local-executor:https://hosted.example.test/device-1/thread-1",
        "delete:com.rika.cli.local-executor:https://hosted.example.test/device-1/thread-1",
        "get:com.rika.cli.local-executor:https://hosted.example.test/device-1/thread-1",
      ])
    }),
  ),
)

it.effect("rejects corrupt local executor receipts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const vault: SecretVault = {
        get: () => Promise.resolve("{\"version\":1,\"workspaceIdentity\":null}"),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      }
      const context = yield* Layer.build(receiptLayer(vault))
      const store = Context.get(context, LocalExecutorReceiptStore)
      const error = yield* Effect.flip(store.load("receipt-scope"))

      expect(error.kind).toBe("storage")
      expect(error.message).toBe("Local executor receipts are corrupt")
    }),
  ),
)
