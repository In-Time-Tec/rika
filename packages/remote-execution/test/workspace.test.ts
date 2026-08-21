import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { prepare, testing, WorkspaceError } from "../src/workspace"
import { provideLayer } from "./support/layer"

const platform = Layer.merge(BunCrypto.layer, BunFileSystem.layer)
const kernel = { profileDigest: "1".repeat(64), bindingContractDigest: "2".repeat(64) } as const
const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecord = Schema.decodeUnknownEffect(JsonRecord)
const encodeJsonRecord = Schema.encodeEffect(JsonRecord)

const access = {
  version: 1 as const,
  fence: {
    target: "e2b" as const,
    assignmentId: "assignment-1",
    assignmentGeneration: 1,
    instanceId: "sandbox-1",
    executorId: "executor-1",
    processIncarnation: "process-1",
  },
  leaseEpoch: 1,
  sessionToken: "session-secret",
}

it.effect("forces gh API reads to GET and rejects every write-capable surface", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-gh-" })
      const fake = `${root}/real-gh`
      const wrapper = `${root}/gh`
      const credential = `${root}/credential`
      const calls = `${root}/calls`
      const credentialCalls = `${root}/credential-calls`
      yield* fileSystem.writeFileString(
        fake,
        `#!/bin/sh\nif [ "\${1:-}" != --version ] && [ "\${GH_TOKEN:-}" != read-secret ]; then exit 9; fi\nprintf '%s\\n' "$*" >> "${calls}"\n`,
      )
      yield* fileSystem.writeFileString(credential, `#!/bin/sh\nprintf x >> "${credentialCalls}"\nprintf read-secret\n`)
      yield* fileSystem.writeFileString(wrapper, testing.readOnlyGhWrapper(fake, credential))
      yield* fileSystem.chmod(fake, 0o700)
      yield* fileSystem.chmod(credential, 0o700)
      yield* fileSystem.chmod(wrapper, 0o700)
      const run = (args: ReadonlyArray<string>) =>
        Effect.sync(() => Bun.spawnSync([wrapper, ...args], { stdout: "pipe", stderr: "pipe" }))
      expect((yield* run(["--version"])).exitCode).toBe(0)
      expect((yield* run(["repo", "view"])).exitCode).toBe(0)
      expect((yield* run(["issue", "view", "1"])).exitCode).toBe(0)
      expect((yield* run(["pr", "view", "2"])).exitCode).toBe(0)
      expect((yield* run(["api", "repos/example/repo"])).exitCode).toBe(0)
      expect(yield* fileSystem.readFileString(calls)).toBe(
        "--version\nrepo view\nissue view 1\npr view 2\napi --method GET repos/example/repo\n",
      )
      expect(yield* fileSystem.readFileString(credentialCalls)).toBe("xxxx")
      expect(yield* fileSystem.readFileString(wrapper)).not.toContain("read-secret")
      for (const args of [
        ["issue", "create"],
        ["pr", "create"],
        ["api", "graphql"],
        ["api", "repos/example/repo", "--method=POST"],
        ["api", "repos/example/repo", "--hostname=example.test"],
        ["api", "repos/example/repo", "-fvalue=secret"],
        ["repo", "delete"],
      ])
        expect((yield* run(args)).exitCode).toBe(2)
    }),
  ).pipe(provideLayer(BunFileSystem.layer)),
)

it.effect("atomically installs an exact private checkout without exposing its credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-clone-" })
      const root = `${parent}/workspace/repo`
      const stateDirectory = `${parent}/state`
      const credentialRoot = `${parent}/run`
      const command = `${parent}/command`
      const calls = `${parent}/calls`
      const fail = `${parent}/fail`
      const repositoryUrl = "https://github.com/example/repo.git"
      const commitSha = "a".repeat(40)
      yield* fileSystem.writeFileString(
        command,
        `#!/bin/sh
set -eu
while [ "\${1:-}" != git ] && [ "\${1:-}" != gh ]; do shift; done
tool="$1"
shift
printf '%s %s\\n' "$tool" "$*" >> "${calls}"
if [ "$tool" = gh ] || [ "\${1:-}" = --version ]; then exit 0; fi
if [ "\${1:-}" = clone ]; then
  if [ -f "${fail}" ]; then exit 7; fi
  for value in "$@"; do target="$value"; done
  mkdir -p "$target/.git"
  printf '%s' '${repositoryUrl}' > "$target/.remote"
  printf '[remote "origin"]\\n  url = ${repositoryUrl}\\n' > "$target/.git/config"
  exit 0
fi
if [ "\${1:-}" = -C ]; then
  repository="$2"
  shift 2
  case "\${1:-}:\${2:-}" in
    checkout:--detach) printf '%s' "$3" > "$repository/.head" ;;
    config:*) ;;
    remote:set-url) printf '%s' "$4" > "$repository/.remote" ;;
    remote:get-url) cat "$repository/.remote" ;;
    rev-parse:HEAD) cat "$repository/.head" ;;
    merge-base:--is-ancestor) exit 0 ;;
    *) exit 3 ;;
  esac
fi
`,
      )
      yield* fileSystem.chmod(command, 0o700)
      yield* fileSystem.writeFileString(fail, "")
      const purposes: Array<string> = []
      const revoked: Array<string> = []
      const output: Array<string> = []
      const assignment = {
        access,
        workspaceId: "workspace-1",
        wakeId: "wake-1",
        cold: false,
        attempt: 1,
        retry: false,
        templateBuildId: "build-1",
        checkout: {
          ownerId: "owner-1",
          projectId: "project-1",
          repositoryId: "repository-1",
          installationId: "installation-1",
          owner: "example",
          name: "repo",
          ref: "main",
          commitSha,
          private: true,
          gitIdentity: { name: "Rika Test", email: "rika@example.test" },
        },
      } as const
      const options = {
        root,
        workspaceCommandPrefix: [command],
        credentialRoot,
        stateDirectory,
        kernel,
        assignment,
        reporter: {
          started: () => Effect.void,
          output: (_phase: string, _stream: string, text: string) =>
            Effect.sync(() => output.push(text)).pipe(Effect.asVoid),
        },
        credential: (purpose: "git-read" | "github-read") =>
          Effect.gen(function* () {
            purposes.push(purpose)
            return {
              token: Redacted.make(`private-checkout-secret-${purposes.length}`),
              username: "x-access-token" as const,
              repositoryUrl,
              expiresAt: (yield* Clock.currentTimeMillis) + 10 * 60 * 1_000,
            }
          }),
        revoke: (purpose: "git-read" | "github-read") => Effect.sync(() => revoked.push(purpose)).pipe(Effect.asVoid),
      } as const
      expect((yield* Effect.flip(prepare(options))).message).toContain("clone failed")
      expect(yield* fileSystem.exists(root)).toBe(false)
      expect(
        (yield* fileSystem.readDirectory(`${parent}/workspace`)).some((name) => name.startsWith(".rika-checkout")),
      ).toBe(false)
      yield* fileSystem.remove(fail)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const evidence = yield* prepare(options)
          expect(evidence).toMatchObject({
            repositoryId: "repository-1",
            commitSha,
            kernelProfileDigest: kernel.profileDigest,
            bindingContractDigest: kernel.bindingContractDigest,
          })
          expect(yield* fileSystem.readFileString(`${root}/.head`)).toBe(commitSha)
          expect(yield* fileSystem.readFileString(`${root}/.remote`)).toBe(repositoryUrl)
          expect(yield* fileSystem.readFileString(`${root}/.git/config`)).not.toContain("private-checkout-secret")
          expect(yield* fileSystem.exists(`${root}/.agents`)).toBe(false)
          expect(
            (yield* fileSystem.readDirectory(`${parent}/workspace`)).some((name) => name.startsWith(".rika-checkout")),
          ).toBe(false)
          expect(yield* fileSystem.exists(`${credentialRoot}/credentials/github`)).toBe(false)
          expect(yield* fileSystem.exists(`${credentialRoot}/gh/hosts.yml`)).toBe(false)
          expect(yield* fileSystem.exists(`${credentialRoot}/credential.sock`)).toBe(true)
          expect(yield* fileSystem.readFileString(`${credentialRoot}/git-credential-rika`)).not.toContain(
            "private-checkout-secret",
          )
          const invoke = (arguments_: ReadonlyArray<string>) =>
            Effect.acquireRelease(
              Effect.sync(() => Bun.spawn([...arguments_], { stdout: "pipe", stderr: "pipe" })),
              (process) => Effect.promise(() => process.exited).pipe(Effect.ignore),
            ).pipe(
              Effect.flatMap((process) =>
                Effect.all([
                  Effect.promise(() => new Response(process.stdout).text()),
                  Effect.promise(() => process.exited),
                ]),
              ),
            )
          const [gitCredential, gitExit] = yield* invoke([`${credentialRoot}/git-credential-rika`, "get"])
          expect(gitExit).toBe(0)
          expect(gitCredential).toContain("password=private-checkout-secret-3")
          const [ghVersion, ghExit] = yield* invoke([`${credentialRoot}/bin/gh`, "--version"])
          expect(ghExit).toBe(0)
          expect(ghVersion).toContain("gh version")
          yield* TestClock.adjust("5 minutes")
          yield* Effect.yieldNow
          expect(purposes).toEqual(["git-read", "git-read", "git-read", "github-read", "git-read", "github-read"])
          const [refreshed] = yield* invoke([`${credentialRoot}/git-credential-rika`, "get"])
          expect(refreshed).toContain("password=private-checkout-secret-5")
        }),
      )
      expect(yield* fileSystem.exists(`${credentialRoot}/credential.sock`)).toBe(false)
      expect(yield* fileSystem.exists(`${credentialRoot}/git-credential-rika`)).toBe(false)
      yield* fileSystem.writeFileString(`${root}/modified`, "before")
      yield* fileSystem.writeFileString(`${root}/modified`, "after")
      yield* fileSystem.writeFileString(`${root}/untracked`, "keep")
      yield* Effect.scoped(
        prepare({
          ...options,
          assignment: {
            ...assignment,
            access: { ...access, leaseEpoch: 2 },
            wakeId: "wake-2",
            cold: true,
          },
        }),
      )
      expect(yield* fileSystem.readFileString(`${root}/modified`)).toBe("after")
      expect(yield* fileSystem.readFileString(`${root}/untracked`)).toBe("keep")
      const invoked = yield* fileSystem.readFileString(calls)
      expect(invoked).toContain("config --local user.name Rika Test")
      expect(invoked).toContain("config --local user.email rika@example.test")
      expect(invoked).not.toContain("private-checkout-secret")
      expect(output.join("\n")).not.toContain("private-checkout-secret")
      expect(revoked).toContain("git-read")
      expect(revoked).toContain("github-read")
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("prepares an empty workspace and runs resume exactly once per cold wake without discarding files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workspace-" })
      const root = `${parent}/workspace/repo`
      const stateDirectory = `${parent}/state`
      const phases: Array<string> = []
      const output: Array<string> = []
      const reporter = {
        started: (phase: string) => Effect.sync(() => phases.push(phase)).pipe(Effect.asVoid),
        output: (_phase: string, _stream: string, text: string) =>
          Effect.sync(() => output.push(text)).pipe(Effect.asVoid),
      }
      const base = {
        root,
        workspaceCommandPrefix: [],
        stateDirectory,
        kernel,
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
      yield* fileSystem.makeDirectory(`${root}/.agents`, { recursive: true })
      yield* fileSystem.writeFileString(
        `${root}/.agents/setup`,
        `#!/bin/sh\nprintf 'token=fixture-secret-opaque\\n'\nprintf x >> "${root}/setup-count"\n`,
      )
      yield* fileSystem.chmod(`${root}/.agents/setup`, 0o700)
      yield* fileSystem.writeFileString(`${root}/.agents/resume`, `#!/bin/sh\nprintf x >> "${root}/resume-count"\n`)
      yield* fileSystem.chmod(`${root}/.agents/resume`, 0o700)
      yield* fileSystem.writeFileString(`${root}/untracked`, "keep")
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
      expect(yield* fileSystem.readFileString(`${root}/untracked`)).toBe("keep")
      yield* prepare({ ...base, assignment: coldAssignment })
      expect(yield* fileSystem.readFileString(`${root}/resume-count`)).toBe("x")
      const markerDirectory = `${stateDirectory}/workspace`
      const markerName = (yield* fileSystem.readDirectory(markerDirectory)).find((name) => name.endsWith(".json"))!
      const markerPath = `${markerDirectory}/${markerName}`
      const marker = yield* decodeJsonRecord(yield* fileSystem.readFileString(markerPath))
      yield* fileSystem.writeFileString(markerPath, yield* encodeJsonRecord({ ...marker, setupState: "failed" }))
      const retry = yield* prepare({
        ...base,
        assignment: {
          ...coldAssignment,
          access: { ...access, leaseEpoch: 3 },
          wakeId: "wake-3",
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
        Effect.flatMap((value) => {
          const marker = JSON.parse(value) as { setupState: string }
          marker.setupState = "failed"
          return fileSystem.writeFileString(markerPath, JSON.stringify(marker))
        }),
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
      expect(Bun.env.RIKA_CHILD_ONLY).toBeUndefined()
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
