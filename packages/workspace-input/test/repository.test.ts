import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, FileSystem, Layer } from "effect"
import { createArchive, restoreArchive } from "../src/archive"
import { Archive, MaximumArchiveBytes } from "../src/contract"
import { RepositoryTransport, captureRepositoryInput, restoreRepositoryInput } from "../src/repository"
import { gitOutput, layerLocalRepositoryTransport, runGit, withPlatform } from "./repository.support"

const metadata = (commitSha: string) => ({
  version: 1,
  source: { owner: "example-owner", name: "example-repository" },
  commitSha,
  gitIdentity: { name: "Rika Test", email: "rika@example.test" },
})

const provideTransport = <A, E, R>(source: string, effect: Effect.Effect<A, E, R | RepositoryTransport>) =>
  Effect.scoped(
    Layer.build(layerLocalRepositoryTransport(source)).pipe(
      Effect.flatMap((context) => Effect.provide(effect, context)),
    ),
  )

const write = (target: Uint8Array, offset: number, length: number, value: string) =>
  target.set(new TextEncoder().encode(value).subarray(0, length), offset)

const traversalArchive = Effect.fn("RepositoryInputTest.traversalArchive")(function* () {
  const header = new Uint8Array(512)
  const content = new TextEncoder().encode("escape")
  write(header, 0, 100, "../escape.txt")
  write(header, 100, 8, "0000644\0")
  write(header, 108, 8, "0000000\0")
  write(header, 116, 8, "0000000\0")
  write(header, 124, 12, `${content.byteLength.toString(8).padStart(11, "0")}\0`)
  write(header, 136, 12, "00000000000\0")
  header.fill(0x20, 148, 156)
  write(header, 156, 1, "0")
  write(header, 257, 6, "ustar\0")
  write(header, 263, 2, "00")
  let checksum = 0
  for (const byte of header) checksum += byte
  write(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  const bytes = new Uint8Array(2_048)
  bytes.set(header)
  bytes.set(content, 512)
  const crypto = yield* Crypto.Crypto
  const digest = Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes))
  return Archive.make({ bytes, contentDigest: `sha256:${digest}`, sizeBytes: bytes.byteLength })
})

describe("Repository input", () => {
  it.effect("captures and restores only the pinned shallow commit as a real checkout", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-repository-input-test-" })
          const source = `${root}/source`
          const workspace = `${root}/workspaces/checkout`
          yield* fileSystem.makeDirectory(source)
          yield* fileSystem.makeDirectory(`${root}/workspaces`)
          yield* runGit(source, ["init", "--quiet"])
          yield* runGit(source, ["config", "user.name", "Rika Test"])
          yield* runGit(source, ["config", "user.email", "rika@example.test"])
          yield* fileSystem.writeFileString(`${source}/state.txt`, "first")
          yield* runGit(source, ["add", "state.txt"])
          yield* runGit(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "first"])
          yield* fileSystem.writeFileString(`${source}/state.txt`, "pinned")
          yield* runGit(source, ["commit", "--quiet", "--no-gpg-sign", "-am", "pinned"])
          const pinned = yield* gitOutput(source, ["rev-parse", "HEAD"])
          yield* fileSystem.writeFileString(`${source}/state.txt`, "later")
          yield* runGit(source, ["commit", "--quiet", "--no-gpg-sign", "-am", "later"])
          const later = yield* gitOutput(source, ["rev-parse", "HEAD"])
          yield* fileSystem.writeFileString(`${source}/state.txt`, "dirty working tree")

          const input = yield* provideTransport(source, captureRepositoryInput({ metadata: metadata(pinned) }))
          expect(input.metadata.commitSha).toBe(pinned)
          expect(input.metadata.commitSha).not.toBe(later)
          const unpacked = `${root}/archive-inspection`
          yield* restoreArchive(unpacked, input.archive)
          expect(yield* fileSystem.exists(`${unpacked}/repository/config`)).toBe(false)
          expect(yield* fileSystem.exists(`${unpacked}/repository/hooks`)).toBe(false)
          expect(yield* fileSystem.readFileString(`${unpacked}/repository/shallow`)).toBe(`${pinned}\n`)

          yield* restoreRepositoryInput({ input, workspace })
          expect(yield* fileSystem.readFileString(`${workspace}/state.txt`)).toBe("pinned")
          expect(yield* gitOutput(workspace, ["rev-parse", "HEAD"])).toBe(pinned)
          expect(yield* gitOutput(workspace, ["rev-parse", "--is-shallow-repository"])).toBe("true")
          expect((yield* gitOutput(workspace, ["rev-list", "HEAD"])).split("\n")).toEqual([pinned])
          expect(yield* fileSystem.readFileString(`${workspace}/.git/HEAD`)).toBe(`${pinned}\n`)
          expect(yield* fileSystem.readFileString(`${workspace}/.git/refs/heads/rika-input`)).toBe(`${pinned}\n`)
          expect(yield* gitOutput(workspace, ["remote", "get-url", "origin"])).toBe(
            "https://github.com/example-owner/example-repository.git",
          )
          expect(yield* gitOutput(workspace, ["config", "--local", "user.name"])).toBe("Rika Test")
          expect(yield* gitOutput(workspace, ["config", "--local", "user.email"])).toBe("rika@example.test")
          expect(yield* fileSystem.exists(`${workspace}/.git/hooks`)).toBe(false)
          const localConfig = yield* fileSystem.readFileString(`${workspace}/.git/config`)
          expect(localConfig).not.toContain("credential")
          expect(localConfig).not.toContain("extraheader")
        }),
      ),
    ),
  )

  it.effect("rejects malformed descriptors and unsupported Git metadata before publication", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-repository-input-invalid-" })
          const content = `${root}/content`
          yield* fileSystem.makeDirectory(`${content}/repository/hooks`, { recursive: true })
          yield* fileSystem.writeFileString(`${content}/repository/config`, "[credential]\nhelper = unsafe\n")
          yield* fileSystem.writeFileString(`${content}/repository/hooks/post-checkout`, "unsafe")
          const archive = yield* createArchive(content)
          const commitSha = "a".repeat(40)
          const input = {
            format: "git-bare-shallow-v1",
            metadata: metadata(commitSha),
            archive,
          }
          let fetched = false
          const invalidCapture = yield* Effect.flip(
            captureRepositoryInput({
              metadata: { ...input.metadata, source: { owner: "../owner", name: "repo" } },
            }).pipe(
              Effect.provideService(
                RepositoryTransport,
                RepositoryTransport.of({
                  fetch: () => Effect.sync(() => void (fetched = true)),
                }),
              ),
            ),
          )
          expect(invalidCapture.kind).toBe("input")
          expect(fetched).toBe(false)
          for (const [name, invalid] of [
            ["metadata", { ...input, metadata: { ...input.metadata, source: { owner: "../owner", name: "repo" } } }],
            ["token", { ...input, token: "must-not-cross-the-boundary" }],
            ["hooks", input],
            ["oversize", { ...input, archive: { ...archive, sizeBytes: MaximumArchiveBytes + 1 } }],
            ["traversal", { ...input, archive: yield* traversalArchive() }],
          ] as const) {
            const workspace = `${root}/workspace-${name}`
            yield* Effect.flip(restoreRepositoryInput({ input: invalid, workspace }))
            expect(yield* fileSystem.exists(workspace)).toBe(false)
          }
        }),
      ),
    ),
  )

  it.effect("rejects repository links into Git metadata without publishing a workspace", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-repository-input-link-" })
          const source = `${root}/source`
          const workspace = `${root}/workspace`
          yield* fileSystem.makeDirectory(source)
          yield* runGit(source, ["init", "--quiet"])
          yield* runGit(source, ["config", "user.name", "Rika Test"])
          yield* runGit(source, ["config", "user.email", "rika@example.test"])
          yield* fileSystem.symlink(".git/config", `${source}/metadata-link`)
          yield* runGit(source, ["add", "metadata-link"])
          yield* runGit(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "link"])
          const commitSha = yield* gitOutput(source, ["rev-parse", "HEAD"])
          const input = yield* provideTransport(source, captureRepositoryInput({ metadata: metadata(commitSha) }))
          const error = yield* Effect.flip(restoreRepositoryInput({ input, workspace }))
          expect(error.kind).toBe("git")
          expect(yield* fileSystem.exists(workspace)).toBe(false)
        }),
      ),
    ),
  )

  it.effect("never overwrites an existing workspace, including an empty one", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-repository-input-fresh-" })
          const workspace = `${root}/workspace`
          yield* fileSystem.makeDirectory(workspace)
          const error = yield* Effect.flip(
            restoreRepositoryInput({
              workspace,
              input: {
                format: "git-bare-shallow-v1",
                metadata: metadata("a".repeat(40)),
                archive: { bytes: new Uint8Array([97]), contentDigest: `sha256:${"a".repeat(64)}`, sizeBytes: 1 },
              },
            }),
          )
          expect(error.kind).toBe("workspace")
          expect(yield* fileSystem.exists(workspace)).toBe(true)
        }),
      ),
    ),
  )
})
