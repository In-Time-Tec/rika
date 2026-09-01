import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { prepare, WorkspaceError } from "../../src/workspace/service"
import { createArchive, encodeArchive } from "../../src/workspace/artifact/archive-api"
import { provideLayer } from "../support/layer"

const platform = BunServices.layer
const nativeToolRuntime = { digest: "1".repeat(64) } as const
const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecord = Schema.decodeUnknownEffect(JsonRecord)
const encodeJsonRecord = Schema.encodeEffect(JsonRecord)
const access = {
  version: 1 as const,
  fence: {
    target: "orb" as const,
    assignmentId: "assignment-1",
    assignmentGeneration: 1,
    instanceId: "sandbox-1",
    executorId: "executor-1",
    processIncarnation: "process-1",
  },
  leaseEpoch: 1,
  sessionToken: "session-secret",
}

it.effect("prepares an empty workspace and runs resume exactly once per cold wake without discarding files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-" })
      const root = `${parent}/workspace/repo`
      const stateDirectory = `${parent}/state`
      const command = `${parent}/workspace-command`
      const calls = `${parent}/workspace-command-calls`
      yield* fileSystem.writeFileString(
        command,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${calls}"
exec "$@"
`,
      )
      yield* fileSystem.chmod(command, 0o700)
      const phases: Array<string> = []
      const output: Array<string> = []
      const reporter = {
        started: (phase: string) => Effect.sync(() => phases.push(phase)).pipe(Effect.asVoid),
        output: (_phase: string, _stream: string, text: string) =>
          Effect.sync(() => output.push(text)).pipe(Effect.asVoid),
      }
      const base = {
        root,
        workspaceCommandPrefix: [command],
        stateDirectory,
        nativeToolRuntime,
        reporter,
        credential: () =>
          Effect.fail(WorkspaceError.make({ phase: "checkout", message: "unexpected credential", retryable: false })),
        revoke: () => Effect.void,
      } as const
      const fresh = yield* prepare({
        ...base,
        assignment: {
          access,
          workspaceId: "workspace-1",
          wakeId: "wake-1",
          cold: false,
          attempt: 1,
          retry: false,
          templateBuildId: "build-1",
          checkout: null,
        },
      })
      expect(fresh.setup.outcome).toBe("missing")
      expect(yield* fileSystem.readFileString(calls)).toContain(`install -d -m 0750 ${root}`)
      yield* fileSystem.makeDirectory(`${root}/.agents`, { recursive: true })
      yield* fileSystem.writeFileString(
        `${root}/.agents/setup`,
        `#!/bin/sh\nprintf 'token=fixture-secret-opaque\\n'\nprintf x >> "${root}/setup-count"\n`,
      )
      yield* fileSystem.chmod(`${root}/.agents/setup`, 0o700)
      yield* fileSystem.writeFileString(`${root}/.agents/resume`, `#!/bin/sh\nprintf x >> "${root}/resume-count"\n`)
      yield* fileSystem.chmod(`${root}/.agents/resume`, 0o700)
      const modified = Uint8Array.from([0, 255, 109, 111, 100, 105, 102, 105, 101, 100])
      const untracked = Uint8Array.from([117, 110, 116, 114, 97, 99, 107, 101, 100, 0, 255])
      yield* fileSystem.writeFile(`${root}/tracked-modified.bin`, modified)
      yield* fileSystem.writeFile(`${root}/untracked.bin`, untracked)
      const coldAssignment = {
        access: { ...access, leaseEpoch: 2 },
        workspaceId: "workspace-1",
        wakeId: "wake-2",
        cold: true,
        attempt: 1,
        retry: false,
        templateBuildId: "build-1",
        checkout: null,
      } as const
      const cold = yield* prepare({ ...base, assignment: coldAssignment })
      expect(cold.resume?.outcome).toBe("completed")
      expect(yield* fileSystem.exists(`${root}/setup-count`)).toBe(false)
      expect(yield* fileSystem.readFileString(`${root}/resume-count`)).toBe("x")
      expect(Array.from(yield* fileSystem.readFile(`${root}/tracked-modified.bin`))).toEqual(Array.from(modified))
      expect(Array.from(yield* fileSystem.readFile(`${root}/untracked.bin`))).toEqual(Array.from(untracked))
      yield* prepare({ ...base, assignment: coldAssignment })
      expect(yield* fileSystem.readFileString(`${root}/resume-count`)).toBe("x")
      yield* prepare({
        ...base,
        assignment: {
          ...coldAssignment,
          access: { ...access, leaseEpoch: 3 },
          wakeId: "wake-3",
        },
      })
      expect(yield* fileSystem.readFileString(`${root}/resume-count`)).toBe("xx")
      expect(Array.from(yield* fileSystem.readFile(`${root}/tracked-modified.bin`))).toEqual(Array.from(modified))
      expect(Array.from(yield* fileSystem.readFile(`${root}/untracked.bin`))).toEqual(Array.from(untracked))
      const markerDirectory = `${stateDirectory}/workspace`
      const markerName = (yield* fileSystem.readDirectory(markerDirectory)).find((name) => name.endsWith(".json"))!
      const markerPath = `${markerDirectory}/${markerName}`
      const marker = yield* decodeJsonRecord(yield* fileSystem.readFileString(markerPath))
      yield* fileSystem.writeFileString(markerPath, yield* encodeJsonRecord({ ...marker, setupState: "failed" }))
      const retry = yield* prepare({
        ...base,
        assignment: {
          ...coldAssignment,
          access: { ...access, leaseEpoch: 4 },
          wakeId: "wake-4",
          attempt: 2,
          retry: true,
        },
      })
      expect(retry.setup.outcome).toBe("completed")
      expect(yield* fileSystem.readFileString(`${root}/setup-count`)).toBe("x")
      expect(yield* fileSystem.readFileString(`${stateDirectory}/workspace/setup.log`)).not.toContain(
        "fixture-secret-opaque",
      )
      expect(output.join("\n")).not.toContain("fixture-secret-opaque")
      expect(phases).toContain("checkout")
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("restores a local seed into a fresh projectless Orb before running its setup hook", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-seed-" })
      const source = `${parent}/source`
      const root = `${parent}/workspace/repo`
      yield* fileSystem.makeDirectory(`${source}/.agents`, { recursive: true })
      yield* fileSystem.writeFileString(`${source}/local.txt`, "local workspace state")
      yield* fileSystem.writeFileString(
        `${source}/.agents/setup`,
        `#!/bin/sh\nprintf seeded > "${root}/setup-result"\n`,
      )
      yield* fileSystem.chmod(`${source}/.agents/setup`, 0o700)
      const archive = encodeArchive(yield* createArchive(source))

      const evidence = yield* prepare({
        root,
        workspaceCommandPrefix: [],
        stateDirectory: `${parent}/state`,
        nativeToolRuntime,
        reporter: { started: () => Effect.void, output: () => Effect.void },
        credential: () =>
          Effect.fail(WorkspaceError.make({ phase: "checkout", message: "unexpected credential", retryable: false })),
        revoke: () => Effect.void,
        assignment: {
          access,
          workspaceId: "workspace-1",
          wakeId: "wake-seeded",
          cold: false,
          attempt: 1,
          retry: false,
          templateBuildId: "build-1",
          checkout: null,
        },
        seed: { seedId: "seed-1", archive },
      })

      expect(evidence.setup.outcome).toBe("completed")
      expect(yield* fileSystem.readFileString(`${root}/local.txt`)).toBe("local workspace state")
      expect(yield* fileSystem.readFileString(`${root}/setup-result`)).toBe("seeded")
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("rejects a fresh workspace directory without its durable preparation marker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-partial-workspace-" })
      const root = `${parent}/workspace/repo`
      yield* fileSystem.makeDirectory(root, { recursive: true })
      const failure = yield* Effect.flip(
        prepare({
          root,
          workspaceCommandPrefix: [],
          stateDirectory: `${parent}/state`,
          nativeToolRuntime,
          reporter: { started: () => Effect.void, output: () => Effect.void },
          credential: () =>
            Effect.fail(WorkspaceError.make({ phase: "checkout", message: "unexpected credential", retryable: false })),
          revoke: () => Effect.void,
          assignment: {
            access,
            workspaceId: "workspace-1",
            wakeId: "wake-1",
            cold: false,
            attempt: 1,
            retry: false,
            templateBuildId: "build-1",
            checkout: null,
          },
        }),
      )
      expect(failure).toMatchObject({
        phase: "checkout",
        message: "Fresh workspace contains stale or partial checkout state",
        retryable: false,
      })
    }),
  ).pipe(provideLayer(platform)),
)
