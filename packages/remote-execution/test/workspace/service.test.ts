import "./service-preparation.fixture"
import "./service-recovery.fixture"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Redacted, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { TestClock } from "effect/testing"
import { prepare, pushApprovedBranch, testing } from "../../src/workspace/service"
import { createArchive, encodeArchive } from "../../src/workspace/artifact/archive-api"
import { provideLayer } from "../support/layer"

const platform = BunServices.layer
const nativeToolRuntime = { digest: "1".repeat(64) } as const
const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const _decodeJsonRecord = Schema.decodeUnknownEffect(JsonRecord)
const _encodeJsonRecord = Schema.encodeEffect(JsonRecord)
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

it.effect("pushes only an approved HEAD ref with one ephemeral credential and removes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-approved-push-" })
      const root = `${parent}/repo`
      const credentialRoot = `${parent}/run`
      const command = `${parent}/command`
      const calls = `${parent}/calls`
      const unsafe = `${parent}/unsafe`
      const repositoryUrl = "https://github.com/example/repo.git"
      const commitSha = "a".repeat(40)
      yield* fileSystem.makeDirectory(root)
      yield* fileSystem.writeFileString(
        command,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${calls}"
[ "$1" = git ] || exit 2
case " $* " in
  *" -C ${root} rev-parse HEAD "*) printf '%s\n' '${commitSha}' ;;
  *" -C ${root} remote get-url origin "*) printf '%s\n' '${repositoryUrl}' ;;
  *" -C ${root} remote get-url --push origin "*) printf '%s\n' '${repositoryUrl}' ;;
  *" -C ${root} config --local --includes --name-only --get-regexp "*)
    if [ -f "${unsafe}" ]; then printf '%s\n' 'http.extraheader'; else exit 1; fi
    ;;
  *" init --bare "*) ;;
  *" fetch --no-tags ${root} HEAD "*) ;;
  *" rev-parse FETCH_HEAD "*) printf '%s\n' '${commitSha}' ;;
  *" update-ref refs/heads/publication ${commitSha} "*) ;;
  *" symbolic-ref HEAD refs/heads/publication "*) ;;
  *" remote add origin ${repositoryUrl} "*) ;;
  *" push --porcelain origin HEAD:refs/heads/rika/thread-1 "*)
    helper=''
    previous=''
    before=''
    for value in "$@"; do
      case "$previous:$value" in
        -c:credential.helper=*) helper="\${value#credential.helper=}" ;;
      esac
      before="$previous"
      previous="$value"
    done
    [ -n "$helper" ] || exit 4
    supplied=$("$helper" get)
    printf '%s' "$supplied" | grep -q 'password=approved-secret' || exit 5
    [ -z "$("$helper" get)" ] || exit 6
    [ "$before" = origin ] || exit 7
    [ "$previous" = 'HEAD:refs/heads/rika/thread-1' ] || exit 8
    ;;
  *) exit 9 ;;
esac
`,
      )
      yield* fileSystem.chmod(command, 0o700)
      const request = {
        access,
        publicationId: "publication-1",
        ownerId: "owner-1",
        repositoryId: "repository-1",
        workspaceId: "workspace-1",
        branch: "rika/thread-1",
        ref: "refs/heads/rika/thread-1",
        commitSha,
      } as const
      const outcome = yield* pushApprovedBranch({
        request,
        repositoryUrl,
        credential: {
          token: Redacted.make("approved-secret"),
          username: "x-access-token",
          repositoryUrl,
          expiresAt: (yield* Clock.currentTimeMillis) + 10 * 60 * 1_000,
        },
        root,
        workspaceCommandPrefix: [command],
        credentialRoot,
      })
      expect(outcome).toEqual({
        _tag: "Succeeded",
        branch: request.branch,
        ref: request.ref,
        commitSha,
      })
      const recorded = yield* fileSystem.readFileString(calls)
      expect(recorded).toContain(`push --porcelain origin HEAD:${request.ref}`)
      expect(recorded).not.toContain("approved-secret")
      expect(yield* fileSystem.readDirectory(credentialRoot)).toEqual([])
      yield* fileSystem.writeFileString(unsafe, "")
      expect(
        yield* pushApprovedBranch({
          request,
          repositoryUrl,
          credential: {
            token: Redacted.make("unused-secret"),
            username: "x-access-token",
            repositoryUrl,
            expiresAt: (yield* Clock.currentTimeMillis) + 10 * 60 * 1_000,
          },
          root,
          workspaceCommandPrefix: [command],
          credentialRoot,
        }),
      ).toMatchObject({ _tag: "Failed", kind: "stale" })
      expect((yield* fileSystem.readFileString(calls)).match(/push --porcelain/g)).toHaveLength(1)
    }),
  ).pipe(provideLayer(platform)),
)

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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = (args: ReadonlyArray<string>) => spawner.exitCode(ChildProcess.make(wrapper, args))
      expect(Number(yield* run(["--version"]))).toBe(0)
      expect(Number(yield* run(["repo", "view"]))).toBe(0)
      expect(Number(yield* run(["issue", "view", "1"]))).toBe(0)
      expect(Number(yield* run(["pr", "view", "2"]))).toBe(0)
      expect(Number(yield* run(["api", "repos/example/repo"]))).toBe(0)
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
        expect(Number(yield* run(args))).toBe(2)
    }),
  ).pipe(provideLayer(platform)),
)

it.effect("clones a private repository, overlays the local seed, and preserves Git identity", () =>
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
if [ "\${1:-}" = bash ]; then exec "$@"; fi
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
  printf '%s' 'cloned content' > "$target/deleted-locally.txt"
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
      const seedSource = `${parent}/seed`
      yield* fileSystem.makeDirectory(seedSource)
      yield* fileSystem.writeFileString(`${seedSource}/.head`, commitSha)
      yield* fileSystem.writeFileString(`${seedSource}/.remote`, repositoryUrl)
      yield* fileSystem.writeFileString(`${seedSource}/local.txt`, "local workspace state")
      const seed = { seedId: "seed-private", archive: encodeArchive(yield* createArchive(seedSource)) }
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
        nativeToolRuntime,
        assignment,
        seed,
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
            nativeToolRuntimeDigest: nativeToolRuntime.digest,
          })
          expect(yield* fileSystem.readFileString(`${root}/.head`)).toBe(commitSha)
          expect(yield* fileSystem.readFileString(`${root}/.remote`)).toBe(repositoryUrl)
          expect(yield* fileSystem.readFileString(`${root}/local.txt`)).toBe("local workspace state")
          expect(yield* fileSystem.exists(`${root}/deleted-locally.txt`)).toBe(false)
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
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const invoke = (arguments_: readonly [string, ...Array<string>]) =>
            spawner
              .string(ChildProcess.make(arguments_[0], arguments_.slice(1)))
              .pipe(Effect.map((text) => [text, 0] as const))
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
