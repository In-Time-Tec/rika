import { fileURLToPath } from "node:url"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, FileSystem, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createArchive, decodeArchive, inspectArchive, restoreArchive } from "../src/archive"
import { Archive, MaximumArchiveEntries, MaximumArchiveUncompressedBytes } from "../src/contract"
import { run } from "../src/internal/process"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const archiveOf = Effect.fn("WorkspaceInputTest.archiveOf")(function* (bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto
  const digest = Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes))
  return Archive.make({ bytes, contentDigest: `sha256:${digest}`, sizeBytes: bytes.byteLength })
})

const write = (target: Uint8Array, offset: number, length: number, value: string) => {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset)
}

const header = (input: {
  readonly name: string
  readonly size?: number
  readonly type?: string
  readonly link?: string
}) => {
  const value = new Uint8Array(512)
  write(value, 0, 100, input.name)
  write(value, 100, 8, "0000644\0")
  write(value, 108, 8, "0000000\0")
  write(value, 116, 8, "0000000\0")
  write(value, 124, 12, `${(input.size ?? 0).toString(8).padStart(11, "0")}\0`)
  write(value, 136, 12, "00000000000\0")
  value.fill(0x20, 148, 156)
  write(value, 156, 1, input.type ?? "0")
  write(value, 157, 100, input.link ?? "")
  write(value, 257, 6, "ustar\0")
  write(value, 263, 2, "00")
  let checksum = 0
  for (const byte of value) checksum += byte
  write(value, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return value
}

const concatenate = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const tar = (
  entries: ReadonlyArray<{
    readonly content?: Uint8Array
    readonly link?: string
    readonly name: string
    readonly size?: number
    readonly type?: string
  }>,
) => {
  const chunks: Array<Uint8Array> = []
  for (const entry of entries) {
    const content = entry.content ?? new Uint8Array()
    chunks.push(header({ ...entry, size: entry.size ?? content.byteLength }), content)
    const padding = (512 - (content.byteLength % 512)) % 512
    if (padding > 0) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(1_024))
  return concatenate(chunks)
}

describe("Workspace archive", () => {
  it.effect("collects multi-chunk archive output byte-for-byte with its exit code", () => {
    const chunks = Array.from({ length: 1_024 }, (_, index) => new Uint8Array(4_096).fill(index % 256))
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(7)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.fromIterable(chunks),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    )
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(spawner)
        const result = yield* Effect.provide(run({ command: ["archive-fixture"] }), context)
        expect(result.exitCode).toBe(7)
        expect(result.stdout.byteLength).toBe(4 * 1_024 * 1_024)
        for (const [index, chunk] of chunks.entries())
          expect(Buffer.compare(result.stdout.subarray(index * 4_096, (index + 1) * 4_096), chunk)).toBe(0)
        const overflow = yield* Effect.flip(
          Effect.provide(run({ command: ["archive-fixture"], maximumStdoutBytes: 4_095 }), context),
        )
        expect(overflow.reason).toBe("output")
      }),
    )
  })

  it.effect("creates deterministic gzip archives and restores them without replacing repository identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-target-" })
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(`${source}/.git`, { recursive: true })
          yield* fileSystem.makeDirectory(`${source}/.agents/state/run`, { recursive: true })
          yield* fileSystem.makeDirectory(`${source}/nested/.rika/secrets`, { recursive: true })
          yield* fileSystem.writeFileString(`${source}/state.txt`, "durable state")
          yield* fileSystem.writeFileString(`${source}/.git/config`, "source identity")
          yield* fileSystem.writeFileString(`${source}/.agents/state/run/transient`, "transient")
          yield* fileSystem.writeFileString(`${source}/nested/.rika/secrets/token`, "transient")
          yield* fileSystem.writeFileString(`${source}/.env`, "TOKEN=excluded-secret")
          yield* fileSystem.writeFileString(`${source}/.env.staging`, "TOKEN=excluded-staging-secret")
          yield* fileSystem.writeFileString(`${source}/.git-credentials`, "excluded")
          yield* fileSystem.writeFileString(`${source}/.netrc`, "excluded")
          yield* fileSystem.writeFileString(`${source}/.npmrc`, "excluded")
          yield* fileSystem.writeFileString(`${source}/.pypirc`, "excluded")
          const first = yield* createArchive(source)
          const second = yield* createArchive(source)
          expect(first).toEqual(second)
          expect(Array.from(first.bytes.slice(0, 2))).toEqual([0x1f, 0x8b])
          expect(Array.from(first.bytes.slice(4, 8))).toEqual([0, 0, 0, 0])

          yield* fileSystem.makeDirectory(`${target}/.git`, { recursive: true })
          yield* fileSystem.writeFileString(`${target}/.git/config`, "authorized identity")
          yield* fileSystem.writeFileString(`${target}/stale.txt`, "stale")
          yield* restoreArchive(target, first)

          expect(yield* fileSystem.readFileString(`${target}/state.txt`)).toBe("durable state")
          expect(yield* fileSystem.readFileString(`${target}/.git/config`)).toBe("authorized identity")
          expect(yield* fileSystem.exists(`${target}/stale.txt`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.agents/state`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/nested/.rika/secrets`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.env`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.env.staging`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.git-credentials`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.netrc`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.npmrc`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.pypirc`)).toBe(false)
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
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-apple-" })
        yield* Effect.gen(function* () {
          const bytes = yield* fileSystem.readFile(
            fileURLToPath(new URL("./fixtures/apple-workspace.tar.gz", import.meta.url)),
          )
          yield* restoreArchive(target, yield* archiveOf(bytes))
          expect(yield* fileSystem.readFileString(`${target}/workspace.txt`)).toBe("Apple Workspace state\n")
          expect(yield* fileSystem.exists(`${target}/._workspace.txt`)).toBe(false)
        }).pipe(Effect.ensuring(fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )

  it.effect("restores retained zstd Workspace seeds after bounded preflight", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-zstd-" })
        yield* Effect.gen(function* () {
          const gzip = yield* fileSystem.readFile(
            fileURLToPath(new URL("./fixtures/apple-workspace.tar.gz", import.meta.url)),
          )
          const expanded = yield* run({ command: ["gzip", "-dc"], stdin: gzip })
          expect(expanded.exitCode).toBe(0)
          const compressed = yield* run({
            command: ["zstd", "--compress", "--stdout", "--quiet"],
            stdin: expanded.stdout,
          })
          expect(compressed.exitCode).toBe(0)
          yield* restoreArchive(target, yield* archiveOf(compressed.stdout))
          expect(yield* fileSystem.readFileString(`${target}/workspace.txt`)).toBe("Apple Workspace state\n")
        }).pipe(Effect.ensuring(fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )

  it.effect("rejects authorized secret values and archive descriptor corruption without exposing values", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-secret-" })
        yield* Effect.gen(function* () {
          const secret = "exact-workspace-secret-value"
          yield* fileSystem.writeFileString(`${source}/output.txt`, `setup wrote ${secret}`)
          const secretFailure = yield* Effect.flip(createArchive(source, new Set([secret])))
          expect(secretFailure.kind).toBe("secret")
          expect(secretFailure.message).not.toContain(secret)
          yield* fileSystem.writeFileString(`${source}/output.txt`, "safe")
          const archive = yield* createArchive(source)
          expect(
            (yield* Effect.flip(restoreArchive(source, { ...archive, contentDigest: `sha256:${"0".repeat(64)}` })))
              .kind,
          ).toBe("archive")
          const encodedFailure = yield* Effect.flip(
            decodeArchive({ content: `not-base64-${secret}`, contentDigest: archive.contentDigest, sizeBytes: 1 }),
          )
          expect(encodedFailure.kind).toBe("archive")
          expect(encodedFailure.message).not.toContain(secret)
        }).pipe(Effect.ensuring(fileSystem.remove(source, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )

  it.effect("captures tracked changes and untracked files while preserving local deletions and Git ignores", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-git-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-git-target-" })
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
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-credentials-" })
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
            `${fixture}type Session = { readonly accessToken: Redacted.Redacted<string> }\n`,
          )
          yield* createArchive(source)
          yield* fileSystem.writeFileString(
            `${source}/fixture.ts`,
            `${fixture}const session = { accessToken: "local-credential-value" }\n`,
          )
          expect((yield* Effect.flip(createArchive(source))).kind).toBe("secret")
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

  it.effect("preserves safe relative symlinks", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-link-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-link-target-" })
        const git = (arguments_: ReadonlyArray<string>) =>
          spawner
            .exitCode(ChildProcess.make("git", ["-C", source, ...arguments_]))
            .pipe(Effect.flatMap((code) => (Number(code) === 0 ? Effect.void : Effect.die(`git exited ${code}`))))
        yield* Effect.gen(function* () {
          yield* git(["init", "--quiet"])
          yield* fileSystem.writeFileString(`${source}/target.txt`, "linked state")
          yield* fileSystem.symlink("target.txt", `${source}/link.txt`)
          yield* git(["add", "target.txt", "link.txt"])
          const archive = yield* createArchive(source)
          yield* restoreArchive(target, archive)
          expect(yield* fileSystem.readFileString(`${target}/link.txt`)).toBe("linked state")
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

  it.effect("round-trips long paths emitted through tar extension metadata", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-long-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-workspace-input-long-target-" })
        const name = `${"long-path-segment-".repeat(9)}state.txt`
        yield* Effect.gen(function* () {
          yield* fileSystem.writeFileString(`${source}/${name}`, "long path state")
          yield* restoreArchive(target, yield* createArchive(source))
          expect(yield* fileSystem.readFileString(`${target}/${name}`)).toBe("long path state")
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

  it.effect("rejects forbidden paths and escaping or traversed links before extraction", () =>
    withPlatform(
      Effect.gen(function* () {
        for (const bytes of [
          tar([{ name: "../escape.txt", content: new TextEncoder().encode("escape") }]),
          tar([{ name: ".env", content: new TextEncoder().encode("secret") }]),
          tar([{ name: "link", type: "2", link: "../../outside" }]),
          tar([{ name: "hard", type: "1", link: "../../outside" }]),
          tar([
            { name: "directory", type: "5" },
            { name: "link", type: "2", link: "directory" },
            { name: "link/payload", content: new TextEncoder().encode("unsafe") },
          ]),
        ])
          expect((yield* Effect.flip(inspectArchive(yield* archiveOf(bytes)))).kind).toBe("archive")
      }),
    ),
  )

  it.effect("rejects declared expansion and excessive file counts before staging extraction", () =>
    withPlatform(
      Effect.gen(function* () {
        const oversized = tar([{ name: "large.bin", size: MaximumArchiveUncompressedBytes + 1 }])
        const compressed = Bun.gzipSync(oversized)
        expect((yield* Effect.flip(inspectArchive(yield* archiveOf(compressed)))).kind).toBe("size")

        const headers = Array.from({ length: MaximumArchiveEntries + 1 }, (_, index) =>
          header({ name: `entry-${index}` }),
        )
        const crowded = concatenate([...headers, new Uint8Array(1_024)])
        expect((yield* Effect.flip(inspectArchive(yield* archiveOf(crowded)))).kind).toBe("size")
      }),
    ),
  )
})
