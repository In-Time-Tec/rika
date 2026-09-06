import { expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Effect, FileSystem, Option } from "effect"
import { sessionStore } from "../../src/host/persistence"
import type { SessionWire } from "../../src/protocol/messages"
import { provideLayer } from "../support/layer"

it.live("serializes atomic session saves for concurrent process observations and lease receipts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-observation-session-" })
      const store = yield* sessionStore(directory)
      const session: SessionWire = {
        version: 1,
        fence: {
          target: "orb",
          assignmentId: "assignment",
          assignmentGeneration: 1,
          instanceId: "sandbox",
          executorId: "executor",
          processIncarnation: "incarnation",
        },
        leaseEpoch: 1,
        sessionToken: "test-session",
        heartbeatIntervalMillis: 1000,
        cursor: { sequence: 0, value: "" },
        observations: [
          {
            operationKey: "operation",
            attempt: 0,
            machineId: "machine",
            requestDigest: "a".repeat(64),
            observation: { processId: "1", exitCode: 0, elapsedMillis: 1, truncated: false },
          },
        ],
      }
      yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => index),
        (sequence) => store.save({ ...session, cursor: { sequence, value: String(sequence) } }),
        { concurrency: "unbounded", discard: true },
      )
      yield* store.save(session)
      expect(yield* store.load).toEqual(Option.some(session))
      expect(yield* fileSystem.readDirectory(directory)).toEqual(["session.json"])
    }).pipe(provideLayer(BunFileSystem.layer)),
  ),
)
