import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Clock, Config, Effect, FileSystem, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { prepare, WorkspaceError } from "../../src/workspace/service"
import { createArchive, encodeArchive } from "../../src/workspace/artifact/archive-api"
import { provideLayer } from "../support/layer"

const platform = BunServices.layer
const kernel = { profileDigest: "1".repeat(64), bindingContractDigest: "2".repeat(64) } as const
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

it.effect("blocks non-executable, failed, and timed-out setup until an explicit retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-setup-" })
      const root = `${parent}/workspace/repo`
      const stateDirectory = `${parent}/state`
      const base = {
        root,
        workspaceCommandPrefix: [],
        stateDirectory,
        kernel,
        setupTimeout: 20,
        reporter: { started: () => Effect.void, output: () => Effect.void },
        credential: () =>
          Effect.fail(WorkspaceError.make({ phase: "checkout", message: "unexpected credential", retryable: false })),
        revoke: () => Effect.void,
      } as const
      yield* prepare({
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
      yield* fileSystem.makeDirectory(`${root}/.agents`, { recursive: true })
      const setup = `${root}/.agents/setup`
      yield* fileSystem.writeFileString(setup, "#!/bin/sh\nexit 0\n")
      const markerDirectory = `${stateDirectory}/workspace`
      const markerName = (yield* fileSystem.readDirectory(markerDirectory)).find((name) => name.endsWith(".json"))!
      const markerPath = `${markerDirectory}/${markerName}`
      const failMarker = fileSystem.readFileString(markerPath).pipe(
        Effect.flatMap((value) =>
          decodeJsonRecord(value).pipe(
            Effect.flatMap((marker) => encodeJsonRecord({ ...marker, setupState: "failed" })),
            Effect.flatMap((marker) => fileSystem.writeFileString(markerPath, marker)),
          ),
        ),
      )
      yield* failMarker
      const retry = {
        access: { ...access, leaseEpoch: 2 },
        workspaceId: "workspace-1",
        wakeId: "wake-2",
        cold: true,
        attempt: 2,
        retry: true,
        templateBuildId: "build-1",
        checkout: null,
      } as const
      expect((yield* Effect.flip(prepare({ ...base, assignment: retry }))).message).toContain("must be executable")
      yield* fileSystem.writeFileString(setup, "#!/bin/sh\nexit 7\n")
      yield* fileSystem.chmod(setup, 0o700)
      yield* fileSystem.writeFileString(`${markerDirectory}/setup.log`, "stale setup output")
      expect((yield* Effect.flip(prepare({ ...base, assignment: retry }))).message).toContain("exited unsuccessfully")
      expect(yield* fileSystem.readFileString(`${markerDirectory}/setup.log`)).not.toContain("stale setup output")
      yield* fileSystem.writeFileString(setup, "#!/bin/sh\nwhile :; do sleep 1; done\n")
      expect((yield* Effect.flip(TestClock.withLive(prepare({ ...base, assignment: retry })))).message).toContain(
        "timed out",
      )
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("blocks an early resume failure and supervises continuation after the blocking window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-resume-" })
      const root = `${parent}/workspace/repo`
      const stateDirectory = `${parent}/state`
      const base = {
        root,
        workspaceCommandPrefix: [],
        stateDirectory,
        kernel,
        resumeBlockingWindow: 20,
        resumeTimeout: 1_000,
        reporter: { started: () => Effect.void, output: () => Effect.void },
        credential: () =>
          Effect.fail(WorkspaceError.make({ phase: "checkout", message: "unexpected credential", retryable: false })),
        revoke: () => Effect.void,
      } as const
      yield* prepare({
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
      yield* fileSystem.makeDirectory(`${root}/.agents`, { recursive: true })
      const resume = `${root}/.agents/resume`
      yield* fileSystem.writeFileString(resume, "#!/bin/sh\nexit 9\n")
      yield* fileSystem.chmod(resume, 0o700)
      const cold = {
        access: { ...access, leaseEpoch: 2 },
        workspaceId: "workspace-1",
        wakeId: "wake-2",
        cold: true,
        attempt: 1,
        retry: false,
        templateBuildId: "build-1",
        checkout: null,
      } as const
      const failed = yield* Effect.flip(prepare({ ...base, assignment: cold }))
      expect(failed).toMatchObject({ phase: "resume", retryable: true })
      yield* fileSystem.writeFileString(
        resume,
        `#!/bin/sh\nexport RIKA_CHILD_ONLY=value\nwhile [ ! -f "${root}/release" ]; do sleep 0.01; done\nprintf x >> "${root}/continued"\n`,
      )
      const continued = yield* TestClock.withLive(prepare({ ...base, assignment: cold }))
      expect(continued.resume?.outcome).toBe("continued")
      yield* fileSystem.writeFileString(`${root}/release`, "")
      const waitForContinuation: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.suspend(() =>
        fileSystem.exists(`${root}/continued`).pipe(
          Effect.orDie,
          Effect.flatMap((exists) =>
            exists ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(waitForContinuation)),
          ),
        ),
      )
      yield* waitForContinuation
      expect(yield* fileSystem.readFileString(`${root}/continued`)).toBe("x")
      expect(yield* Config.option(Config.string("RIKA_CHILD_ONLY"))).toEqual(Option.none())
      yield* prepare({ ...base, assignment: cold })
      expect(yield* fileSystem.readFileString(`${root}/continued`)).toBe("x")
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("rejects stale cold kernel identity and generation without changing workspace files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-stale-" })
      const root = `${parent}/workspace/repo`
      const stateDirectory = `${parent}/state`
      const base = {
        root,
        workspaceCommandPrefix: [],
        stateDirectory,
        kernel,
        reporter: { started: () => Effect.void, output: () => Effect.void },
        credential: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              token: Redacted.make("unused"),
              username: "x-access-token" as const,
              repositoryUrl: "https://github.com/example/repo.git",
              expiresAt: now + 1_000,
            })),
          ),
        revoke: () => Effect.void,
      } as const
      yield* prepare({
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
      yield* fileSystem.writeFileString(`${root}/untracked`, "keep")
      const kernelError = yield* Effect.flip(
        prepare({
          ...base,
          kernel: { ...kernel, profileDigest: "2".repeat(64) },
          assignment: {
            access: { ...access, leaseEpoch: 2 },
            workspaceId: "workspace-1",
            wakeId: "wake-2",
            cold: true,
            attempt: 1,
            retry: false,
            templateBuildId: "build-1",
            checkout: null,
          },
        }),
      )
      expect(kernelError.message).toContain("Cold workspace identity")
      expect(yield* fileSystem.readFileString(`${root}/untracked`)).toBe("keep")
      const bindingError = yield* Effect.flip(
        prepare({
          ...base,
          kernel: { ...kernel, bindingContractDigest: "3".repeat(64) },
          assignment: {
            access: { ...access, leaseEpoch: 2 },
            workspaceId: "workspace-1",
            wakeId: "wake-2",
            cold: true,
            attempt: 1,
            retry: false,
            templateBuildId: "build-1",
            checkout: null,
          },
        }),
      )
      expect(bindingError.message).toContain("Cold workspace identity")
      expect(yield* fileSystem.readFileString(`${root}/untracked`)).toBe("keep")
      const error = yield* Effect.flip(
        prepare({
          ...base,
          assignment: {
            access: { ...access, fence: { ...access.fence, assignmentGeneration: 2 }, leaseEpoch: 2 },
            workspaceId: "workspace-1",
            wakeId: "wake-2",
            cold: true,
            attempt: 1,
            retry: false,
            templateBuildId: "build-1",
            checkout: null,
          },
        }),
      )
      expect(error).toMatchObject({ phase: "checkout", retryable: false })
      expect(yield* fileSystem.readFileString(`${root}/untracked`)).toBe("keep")
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("restores a verified replacement archive into a clean empty workspace and resumes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-replacement-" })
      const source = `${parent}/checkpoint`
      const root = `${parent}/workspace/repo`
      const modified = Uint8Array.from([0, 255, 109, 111, 100, 105, 102, 105, 101, 100])
      const untracked = Uint8Array.from([117, 110, 116, 114, 97, 99, 107, 101, 100, 0, 255])
      yield* fileSystem.makeDirectory(`${source}/.agents`, { recursive: true })
      yield* fileSystem.writeFileString(`${source}/state.txt`, "checkpoint state")
      yield* fileSystem.writeFile(`${source}/tracked-modified.bin`, modified)
      yield* fileSystem.writeFile(`${source}/untracked.bin`, untracked)
      yield* fileSystem.writeFileString(`${source}/.agents/setup`, "#!/bin/sh\nexit 17\n")
      yield* fileSystem.writeFileString(`${source}/.agents/resume`, `#!/bin/sh\nprintf x > "${root}/resumed"\n`)
      yield* fileSystem.chmod(`${source}/.agents/setup`, 0o700)
      yield* fileSystem.chmod(`${source}/.agents/resume`, 0o700)
      const archive = encodeArchive(yield* createArchive(source))
      const evidence = yield* prepare({
        root,
        workspaceCommandPrefix: [],
        stateDirectory: `${parent}/state`,
        kernel,
        environmentDigest: `sha256:${"3".repeat(64)}`,
        reporter: { started: () => Effect.void, output: () => Effect.void },
        credential: () =>
          Effect.fail(WorkspaceError.make({ phase: "checkout", message: "unexpected credential", retryable: false })),
        revoke: () => Effect.void,
        assignment: {
          access: {
            ...access,
            fence: { ...access.fence, assignmentGeneration: 2, instanceId: "sandbox-2" },
          },
          workspaceId: "workspace-1",
          wakeId: "wake-replacement",
          cold: false,
          attempt: 1,
          retry: false,
          templateBuildId: "build-1",
          checkout: null,
        },
        restore: { checkpointId: "checkpoint-1", archive },
      })
      expect(evidence.lifecycle).toMatchObject({
        restoredCheckpointId: "checkpoint-1",
        environmentDigest: `sha256:${"3".repeat(64)}`,
      })
      expect(evidence.resume?.outcome).toBe("completed")
      expect(yield* fileSystem.readFileString(`${root}/state.txt`)).toBe("checkpoint state")
      expect(yield* fileSystem.readFileString(`${root}/resumed`)).toBe("x")
      expect(Array.from(yield* fileSystem.readFile(`${root}/tracked-modified.bin`))).toEqual(Array.from(modified))
      expect(Array.from(yield* fileSystem.readFile(`${root}/untracked.bin`))).toEqual(Array.from(untracked))
    }),
  ).pipe(provideLayer(platform)),
)
