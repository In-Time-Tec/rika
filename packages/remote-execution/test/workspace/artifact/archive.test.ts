import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createArchive, restoreArchive } from "../../../src/workspace/artifact/archive-api"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

describe("Workspace archive", () => {
  it.effect("creates deterministic scrubbed archives and restores them without replacing repository identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-target-" })
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(`${source}/.git`, { recursive: true })
          yield* fileSystem.makeDirectory(`${source}/.agents/state/run`, { recursive: true })
          yield* fileSystem.writeFileString(`${source}/state.txt`, "durable state")
          yield* fileSystem.writeFileString(`${source}/.git/config`, "source identity")
          yield* fileSystem.writeFileString(`${source}/.agents/state/run/transient`, "transient")
          yield* fileSystem.writeFileString(`${source}/.env`, "TOKEN=excluded-secret")
          yield* fileSystem.writeFileString(`${source}/.env.staging`, "TOKEN=excluded-staging-secret")
          const first = yield* createArchive(source)
          const second = yield* createArchive(source)
          expect(first).toEqual(second)

          yield* fileSystem.makeDirectory(`${target}/.git`, { recursive: true })
          yield* fileSystem.writeFileString(`${target}/.git/config`, "authorized identity")
          yield* fileSystem.writeFileString(`${target}/stale.txt`, "stale")
          yield* restoreArchive(target, first, [])

          expect(yield* fileSystem.readFileString(`${target}/state.txt`)).toBe("durable state")
          expect(yield* fileSystem.readFileString(`${target}/.git/config`)).toBe("authorized identity")
          expect(yield* fileSystem.exists(`${target}/stale.txt`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.agents/state`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.env`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.env.staging`)).toBe(false)
        }).pipe(
          Effect.ensuring(
            Effect.all(
              [
                fileSystem.remove(source, { recursive: true, force: true }),
                fileSystem.remove(target, { recursive: true, force: true }),
              ],
              { discard: true },
            ).pipe(Effect.ignore),
          ),
        )
      }),
    ),
  )

  it.effect("restores gzip Workspace seeds produced by Apple clients", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-gzip-target-" })
        yield* Effect.gen(function* () {
          const bytes = yield* fileSystem.readFile(
            fileURLToPath(new URL("../fixtures/apple-workspace.tar.gz", import.meta.url)),
          )
          yield* restoreArchive(target, {
            bytes,
            contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            sizeBytes: bytes.byteLength,
          })
          expect(yield* fileSystem.readFileString(`${target}/workspace.txt`)).toBe("Apple Workspace state\n")
          expect(yield* fileSystem.exists(`${target}/._workspace.txt`)).toBe(false)
        }).pipe(Effect.ensuring(fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )

  it.effect("rejects authorized secret values and archive descriptor corruption", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-secret-" })
        yield* Effect.gen(function* () {
          yield* fileSystem.writeFileString(`${source}/output.txt`, "setup wrote exact-secret-value")
          expect((yield* Effect.flip(createArchive(source, new Set(["exact-secret-value"])))).kind).toBe("secret")
          yield* fileSystem.writeFileString(`${source}/output.txt`, "safe")
          const archive = yield* createArchive(source)
          expect(
            (yield* Effect.flip(restoreArchive(source, { ...archive, contentDigest: `sha256:${"0".repeat(64)}` }, [])))
              .kind,
          ).toBe("archive")
        }).pipe(Effect.ensuring(fileSystem.remove(source, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )

  it.effect("captures tracked changes and untracked files while preserving local deletions and Git ignores", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-git-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-git-target-" })
        const git = (arguments_: ReadonlyArray<string>) =>
          spawner
            .exitCode(ChildProcess.make("git", ["-C", source, ...arguments_]))
            .pipe(Effect.flatMap((code) => (Number(code) === 0 ? Effect.void : Effect.die(`git exited ${code}`))))
        yield* Effect.gen(function* () {
          yield* git(["init", "--quiet"])
          yield* fileSystem.writeFileString(`${source}/.gitignore`, "ignored/\n")
          yield* fileSystem.writeFileString(`${source}/modified.txt`, "original")
          yield* fileSystem.writeFileString(`${source}/deleted.txt`, "delete me")
          yield* git(["add", ".gitignore", "modified.txt", "deleted.txt"])
          yield* fileSystem.writeFileString(`${source}/modified.txt`, "local change")
          yield* fileSystem.remove(`${source}/deleted.txt`)
          yield* fileSystem.writeFileString(`${source}/untracked.txt`, "local only")
          yield* fileSystem.makeDirectory(`${source}/ignored`, { recursive: true })
          yield* fileSystem.writeFileString(`${source}/ignored/dependency.txt`, "ignored")
          yield* fileSystem.makeDirectory(`${source}/nested/.agents/state/run`, { recursive: true })
          yield* fileSystem.writeFileString(`${source}/nested/.agents/state/run/transient`, "ignored")
          const archive = yield* createArchive(source)

          yield* fileSystem.makeDirectory(`${target}/.git`, { recursive: true })
          yield* fileSystem.writeFileString(`${target}/.git/config`, "clone identity")
          yield* fileSystem.writeFileString(`${target}/deleted.txt`, "cloned content")
          yield* fileSystem.makeDirectory(`${target}/ignored`, { recursive: true })
          yield* fileSystem.writeFileString(`${target}/ignored/dependency.txt`, "cloned ignored content")
          yield* restoreArchive(target, archive)

          expect(yield* fileSystem.readFileString(`${target}/modified.txt`)).toBe("local change")
          expect(yield* fileSystem.readFileString(`${target}/untracked.txt`)).toBe("local only")
          expect(yield* fileSystem.exists(`${target}/deleted.txt`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/ignored`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/nested/.agents/state`)).toBe(false)
          expect(yield* fileSystem.readFileString(`${target}/.git/config`)).toBe("clone identity")
        }).pipe(
          Effect.ensuring(
            Effect.all(
              [
                fileSystem.remove(source, { recursive: true, force: true }),
                fileSystem.remove(target, { recursive: true, force: true }),
              ],
              { discard: true },
            ).pipe(Effect.ignore),
          ),
        )
      }),
    ),
  )

  it.effect("allows committed credential fixtures but rejects credential material in local changes", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-credentials-" })
        const git = (arguments_: ReadonlyArray<string>) =>
          spawner
            .exitCode(ChildProcess.make("git", ["-C", source, ...arguments_]))
            .pipe(Effect.flatMap((code) => (Number(code) === 0 ? Effect.void : Effect.die(`git exited ${code}`))))
        yield* Effect.gen(function* () {
          yield* git(["init", "--quiet"])
          const fixture = ["const api_", 'key = "', ["committed", "fixture", "value"].join("-"), '"\n'].join("")
          yield* fileSystem.writeFileString(`${source}/fixture.ts`, fixture)
          yield* git(["add", "fixture.ts"])
          yield* git([
            "-c",
            "user.name=Rika Test",
            "-c",
            "user.email=rika@example.test",
            "commit",
            "--no-gpg-sign",
            "--quiet",
            "-m",
            "fixture",
          ])
          yield* createArchive(source)

          yield* fileSystem.writeFileString(`${source}/fixture.ts`, `${fixture}const safe = true\n`)
          yield* createArchive(source)
          yield* fileSystem.writeFileString(
            `${source}/fixture.ts`,
            `${fixture}const session = { accessToken: Redacted.make("access") }\n`,
          )
          yield* createArchive(source)
          const credential = ["pass", "word=", ["local", "credential", "value"].join("-")].join("")
          yield* fileSystem.writeFileString(`${source}/local.txt`, credential)
          expect((yield* Effect.flip(createArchive(source))).kind).toBe("secret")
        }).pipe(Effect.ensuring(fileSystem.remove(source, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )
})
