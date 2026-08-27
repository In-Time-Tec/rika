import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import type { ForegroundRunnerSnapshot } from "@rika/remote-execution/foreground"
import { makeRunnerReceiptStore } from "../../src/runner/receipt-store"

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)
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

it.layer(platform)((test) => {
  test.effect("stores owner-only Runner recovery files by assignment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-receipt-" })
        const directory = path.join(root, "runner-receipts")
        const store = yield* makeRunnerReceiptStore({
          origin: "https://hosted.example.test/path",
          deviceId: "device-1",
          directory,
        })
        yield* store.save("assignment-1", snapshot)
        expect(Option.getOrThrow(yield* store.load("assignment-1"))).toEqual(snapshot)
        expect(yield* store.load("assignment-2")).toEqual(Option.none())
        const files = yield* fileSystem.readDirectory(directory)
        expect(files).toHaveLength(1)
        expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700)
        expect((yield* fileSystem.stat(path.join(directory, files[0]!))).mode & 0o777).toBe(0o600)
        yield* store.remove("assignment-1")
        expect(yield* store.load("assignment-1")).toEqual(Option.none())
      }),
    ),
  )
})
