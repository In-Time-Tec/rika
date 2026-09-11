import * as BunServices from "@effect/platform-bun/BunServices"
import {
  BoxWorkspaceInputDocument,
  BoxWorkspaceInputPolicy,
  BoxWorkspaceInputReceipt,
  boxWorkspaceInputPartPath,
  boxWorkspaceInputPaths,
  workspaceInputChunkBytes,
  workspaceInputReceiptRelativePath,
} from "@rika/box-executor/workspace-input-contract"
import { createArchive } from "@rika/workspace-input/archive"
import type { Archive } from "@rika/workspace-input/contract"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, FileSystem, Layer, Predicate, Schema, Sink, Stdio, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { maxWorkspaceInputDocumentBytes, runWorkspaceInput } from "../../src/box/workspace-input"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const receiptToJson = Schema.encodeSync(Schema.fromJsonString(BoxWorkspaceInputReceipt))

type PolicyEncoded = typeof BoxWorkspaceInputPolicy.Encoded
type DocumentEncoded = typeof BoxWorkspaceInputDocument.Encoded

const policyJson = (input: {
  readonly checkout?: PolicyEncoded["checkout"]
  readonly seed?: PolicyEncoded["seed"]
}): PolicyEncoded => ({
  workspaceId: "box-workspace",
  placement: { _tag: "Orb" as const, workspaceId: "box-workspace", lineageId: "box-lineage" },
  buildId: "box-build",
  protocolVersion: 1,
  checkout: input.checkout ?? null,
  seed: input.seed ?? null,
})

const checkoutJson = (commitSha: string): NonNullable<PolicyEncoded["checkout"]> => ({
  ownerId: "owner",
  projectId: "project",
  repositoryId: "repository",
  installationId: "installation",
  owner: "example-owner",
  name: "example-repository",
  ref: "refs/heads/main",
  commitSha,
  private: false,
  gitIdentity: { name: "Rika Test", email: "rika@example.test" },
})

type DocumentSources = {
  readonly repository?: DocumentEncoded["repository"]
  readonly seed?: DocumentEncoded["seed"]
}

const documentJson = (policy: PolicyEncoded, input: DocumentSources): DocumentEncoded => ({
  _tag: "Materialize",
  version: 1,
  policy,
  repository: input.repository ?? null,
  seed: input.seed ?? null,
})

const descriptor = (archive: Archive): NonNullable<DocumentEncoded["seed"]> => ({
  contentDigest: archive.contentDigest,
  sizeBytes: archive.sizeBytes,
})

const decodePolicy = (json: PolicyEncoded) => Schema.decodeEffect(BoxWorkspaceInputPolicy)(json)

const printedReceipt = (written: ReadonlyArray<string>) =>
  Schema.decodeEffect(Schema.fromJsonString(BoxWorkspaceInputReceipt))(written.join(""))

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

interface Roots {
  readonly inputDirectory: string
  readonly workspace: string
}

const materialize = (
  document: DocumentEncoded,
  roots: Roots,
  written: Array<string>,
  stdin?: Stream.Stream<Uint8Array>,
) =>
  runWorkspaceInput(roots).pipe(
    Effect.provideService(
      Stdio.Stdio,
      Stdio.make({
        args: Effect.succeed(["workspace-input", "--stdin"]),
        stdin: stdin ?? Stream.make(encoder.encode(toJsonText(document))),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => written.push(Predicate.isString(chunk) ? chunk : decoder.decode(chunk))),
          ),
        stderr: () => Sink.drain,
      }),
    ),
  )

const git = Effect.fn("BoxWorkspaceInputTest.git")(function* (arguments_: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner.exitCode(
    ChildProcess.make("git", [...arguments_], { stdout: "ignore", stderr: "ignore" }),
  )
  if (Number(code) !== 0) return yield* Effect.die(`git exited ${code}`)
})

const gitIn = (directory: string, arguments_: ReadonlyArray<string>) => git(["-C", directory, ...arguments_])

const gitOutput = Effect.fn("BoxWorkspaceInputTest.gitOutput")(function* (
  directory: string,
  arguments_: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = yield* spawner.string(
    ChildProcess.make("git", ["-C", directory, ...arguments_], { stdout: "pipe", stderr: "ignore" }),
  )
  return output.trim()
})

const writeParts = Effect.fn("BoxWorkspaceInputTest.writeParts")(function* (
  root: string,
  policy: BoxWorkspaceInputPolicy,
  source: "repository" | "seed",
  bytes: Uint8Array,
  parts?: ReadonlyArray<number>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = boxWorkspaceInputPaths(policy, root)
  yield* fileSystem.makeDirectory(paths.directory, { recursive: true })
  const count = Math.ceil(bytes.byteLength / workspaceInputChunkBytes)
  for (const part of parts ?? Array.from({ length: count }, (_, index) => index))
    yield* fileSystem.writeFile(
      boxWorkspaceInputPartPath({ policy, source, part, directory: root }),
      bytes.subarray(part * workspaceInputChunkBytes, (part + 1) * workspaceInputChunkBytes),
    )
})

const writeFiles = Effect.fn("BoxWorkspaceInputTest.writeFiles")(function* (
  directory: string,
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  for (const [name, content] of Object.entries(files)) {
    const file = `${directory}/${name}`
    yield* fileSystem.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
    yield* fileSystem.writeFileString(file, content)
  }
})

const seedArchive = Effect.fn("BoxWorkspaceInputTest.seedArchive")(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const source = `${root}/seed-source`
  yield* writeFiles(source, files)
  return yield* createArchive(source)
})

const repositoryArchive = Effect.fn("BoxWorkspaceInputTest.repositoryArchive")(function* (input: {
  readonly root: string
  readonly files: Readonly<Record<string, string>>
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const source = `${input.root}/repository-source`
  const bare = `${input.root}/source.git`
  yield* writeFiles(source, input.files)
  yield* gitIn(source, ["init", "--quiet"])
  yield* gitIn(source, ["config", "user.name", "Rika Test"])
  yield* gitIn(source, ["config", "user.email", "rika@example.test"])
  yield* gitIn(source, ["add", "."])
  yield* gitIn(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "pinned"])
  const commitSha = yield* gitOutput(source, ["rev-parse", "HEAD"])
  yield* git(["init", "--quiet", "--bare", "--object-format=sha1", "--initial-branch=rika-input", bare])
  yield* git([
    "-c",
    "protocol.file.allow=always",
    "-c",
    "fetch.unpackLimit=1",
    "--git-dir",
    bare,
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--depth=1",
    "--no-recurse-submodules",
    source,
    `${commitSha}:refs/heads/rika-input`,
  ])
  const content = `${input.root}/repository-content`
  yield* fileSystem.makeDirectory(`${content}/repository/objects/pack`, { recursive: true })
  yield* fileSystem.makeDirectory(`${content}/repository/refs/heads`, { recursive: true })
  for (const name of yield* fileSystem.readDirectory(`${bare}/objects/pack`))
    yield* fileSystem.copyFile(`${bare}/objects/pack/${name}`, `${content}/repository/objects/pack/${name}`)
  yield* fileSystem.writeFileString(`${content}/repository/HEAD`, "ref: refs/heads/rika-input\n")
  yield* fileSystem.writeFileString(`${content}/repository/refs/heads/rika-input`, `${commitSha}\n`)
  yield* fileSystem.writeFileString(`${content}/repository/shallow`, `${commitSha}\n`)
  const archive = yield* createArchive(content)
  return { archive, commitSha }
})

const seedPolicy = (archive: Archive): NonNullable<PolicyEncoded["seed"]> => ({
  id: "seed-1",
  sourceRepository: null,
  archiveDigest: archive.contentDigest,
  archiveSizeBytes: archive.sizeBytes,
})

describe("Box workspace input", () => {
  it.effect("materializes a seed archive into a fresh workspace and publishes its receipt", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-" })
          const inputDirectory = `${root}/input`
          const workspace = `${root}/workspace`
          const seed = yield* seedArchive(root, { "seed.txt": "seed state", "nested/data.txt": "nested" })
          const json = policyJson({ seed: seedPolicy(seed) })
          const policy = yield* decodePolicy(json)
          const paths = boxWorkspaceInputPaths(policy, inputDirectory)
          yield* writeParts(inputDirectory, policy, "seed", seed.bytes)

          const written: Array<string> = []
          const receipt = yield* materialize(
            documentJson(json, { seed: descriptor(seed) }),
            { inputDirectory, workspace },
            written,
          )

          expect(receipt).toEqual({ version: 1, policyDigest: paths.policyDigest })
          expect(yield* printedReceipt(written)).toEqual(receipt)
          expect(yield* fileSystem.readFileString(`${workspace}/seed.txt`)).toBe("seed state")
          expect(yield* fileSystem.readFileString(`${workspace}/nested/data.txt`)).toBe("nested")
          expect(yield* fileSystem.exists(`${workspace}/.git`)).toBe(false)
          const stored = yield* fileSystem.readFileString(`${workspace}/${workspaceInputReceiptRelativePath}`)
          expect(yield* printedReceipt([stored])).toEqual(receipt)
          expect(yield* fileSystem.exists(paths.directory)).toBe(false)
        }),
      ),
    ),
  )

  it.effect("skips materialization when a matching receipt already exists, even over an occupied workspace", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-skip-" })
          const inputDirectory = `${root}/input`
          const workspace = `${root}/workspace`
          const seed = yield* seedArchive(root, { "seed.txt": "seed state" })
          const json = policyJson({ seed: seedPolicy(seed) })
          const policy = yield* decodePolicy(json)
          const paths = boxWorkspaceInputPaths(policy, inputDirectory)
          const document = documentJson(json, { seed: descriptor(seed) })

          yield* writeParts(inputDirectory, policy, "seed", seed.bytes)
          const first: Array<string> = []
          yield* materialize(document, { inputDirectory, workspace }, first)

          yield* fileSystem.writeFileString(`${workspace}/agent-work.txt`, "untracked agent work")
          const second: Array<string> = []
          const receipt = yield* materialize(document, { inputDirectory, workspace }, second)

          expect(receipt.policyDigest).toBe(paths.policyDigest)
          expect(yield* printedReceipt(second)).toEqual(receipt)
          expect(yield* fileSystem.readFileString(`${workspace}/agent-work.txt`)).toBe("untracked agent work")
        }),
      ),
    ),
  )

  it.effect("refuses an occupied workspace and a mismatched or invalid receipt", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-conflict-" })
          const inputDirectory = `${root}/input`
          const workspace = `${root}/workspace`
          const seed = yield* seedArchive(root, { "seed.txt": "seed state" })
          const json = policyJson({ seed: seedPolicy(seed) })
          const policy = yield* decodePolicy(json)
          const document = documentJson(json, { seed: descriptor(seed) })
          yield* writeParts(inputDirectory, policy, "seed", seed.bytes)

          yield* fileSystem.makeDirectory(workspace)
          yield* fileSystem.writeFileString(`${workspace}/agent.txt`, "agent work")
          const occupiedFailure = yield* Effect.flip(materialize(document, { inputDirectory, workspace }, []))
          expect(occupiedFailure).toMatchObject({ reason: "conflict" })
          expect(yield* fileSystem.readFileString(`${workspace}/agent.txt`)).toBe("agent work")

          yield* fileSystem.remove(`${workspace}/agent.txt`)
          yield* fileSystem.makeDirectory(`${workspace}/.rika/secrets`, { recursive: true })
          yield* fileSystem.writeFileString(
            `${workspace}/${workspaceInputReceiptRelativePath}`,
            receiptToJson({ version: 1, policyDigest: "0".repeat(64) }),
          )
          const mismatched = yield* Effect.flip(materialize(document, { inputDirectory, workspace }, []))
          expect(mismatched).toMatchObject({ reason: "conflict" })

          yield* fileSystem.writeFileString(`${workspace}/${workspaceInputReceiptRelativePath}`, "not json")
          const invalid = yield* Effect.flip(materialize(document, { inputDirectory, workspace }, []))
          expect(invalid).toMatchObject({ reason: "conflict" })
        }),
      ),
    ),
  )

  it.effect("rejects corrupted, truncated, and missing archive parts", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-archive-" })
          const seed = yield* seedArchive(root, { "seed.txt": "seed state" })
          const json = policyJson({ seed: seedPolicy(seed) })
          const policy = yield* decodePolicy(json)
          const document = documentJson(json, { seed: descriptor(seed) })

          const missingRoots = { inputDirectory: `${root}/missing/input`, workspace: `${root}/missing/workspace` }
          const missing = yield* Effect.flip(materialize(document, missingRoots, []))
          expect(missing).toMatchObject({ reason: "transport" })

          const crypto = yield* Crypto.Crypto
          const raw = new Uint8Array(workspaceInputChunkBytes + 1).fill(7)
          const rawDigest = `sha256:${Encoding.encodeHex(yield* crypto.digest("SHA-256", raw))}`
          const rawJson = policyJson({
            seed: {
              id: "seed-raw",
              sourceRepository: null,
              archiveDigest: rawDigest,
              archiveSizeBytes: raw.byteLength,
            },
          })
          const rawPolicy = yield* decodePolicy(rawJson)
          const rawDocument = documentJson(rawJson, {
            seed: { contentDigest: rawDigest, sizeBytes: raw.byteLength },
          })
          const partialRoots = { inputDirectory: `${root}/partial/input`, workspace: `${root}/partial/workspace` }
          yield* writeParts(partialRoots.inputDirectory, rawPolicy, "seed", raw, [0])
          const partial = yield* Effect.flip(materialize(rawDocument, partialRoots, []))
          expect(partial).toMatchObject({ reason: "transport" })

          const corruptedRoots = { inputDirectory: `${root}/corrupted/input`, workspace: `${root}/corrupted/workspace` }
          yield* writeParts(
            corruptedRoots.inputDirectory,
            policy,
            "seed",
            Uint8Array.from(seed.bytes, (byte) => byte ^ 0xff),
          )
          const corrupted = yield* Effect.flip(materialize(document, corruptedRoots, []))
          expect(corrupted).toMatchObject({ reason: "archive" })

          const truncatedRoots = { inputDirectory: `${root}/truncated/input`, workspace: `${root}/truncated/workspace` }
          yield* writeParts(
            truncatedRoots.inputDirectory,
            policy,
            "seed",
            seed.bytes.subarray(0, Math.max(1, seed.bytes.byteLength - 1)),
          )
          const truncated = yield* Effect.flip(materialize(document, truncatedRoots, []))
          expect(truncated).toMatchObject({ reason: "archive" })
        }),
      ),
    ),
  )

  it.effect("rejects invalid documents and policy inconsistencies before touching the workspace", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-invalid-" })
          const inputDirectory = `${root}/input`
          const workspace = `${root}/workspace`
          const seed = yield* seedArchive(root, { "seed.txt": "seed state" })
          const json = policyJson({ seed: seedPolicy(seed) })
          const policy = yield* decodePolicy(json)
          const document = documentJson(json, { seed: descriptor(seed) })

          const inputs: ReadonlyArray<[string, Stream.Stream<Uint8Array>]> = [
            ["empty", Stream.empty],
            ["oversized", Stream.make(new Uint8Array(maxWorkspaceInputDocumentBytes + 1))],
            ["utf8", Stream.make(new Uint8Array([0xff, 0xfe, 0xfd]))],
            ["json", Stream.make(encoder.encode("not json"))],
            ["schema", Stream.make(encoder.encode(toJsonText({ _tag: "Other", version: 1 })))],
          ]
          const roots = { inputDirectory, workspace }
          for (const [name, stdin] of inputs) {
            const failure = yield* Effect.flip(materialize(document, roots, [], stdin))
            expect(failure, name).toMatchObject({ reason: "input" })
          }

          const missingCheckout = yield* Effect.flip(
            materialize(documentJson(json, { repository: descriptor(seed), seed: descriptor(seed) }), roots, []),
          )
          expect(missingCheckout).toMatchObject({ reason: "policy" })

          const withoutSeed = policyJson({})
          const missingSeed = yield* Effect.flip(
            materialize(documentJson(withoutSeed, { seed: descriptor(seed) }), roots, []),
          )
          expect(missingSeed).toMatchObject({ reason: "policy" })

          const mismatched = policyJson({ seed: { ...seedPolicy(seed), archiveSizeBytes: seed.sizeBytes + 1 } })
          const mismatchedFailure = yield* Effect.flip(
            materialize(documentJson(mismatched, { seed: descriptor(seed) }), roots, []),
          )
          expect(mismatchedFailure).toMatchObject({ reason: "policy" })

          expect(yield* fileSystem.exists(workspace)).toBe(false)
          expect(yield* fileSystem.exists(boxWorkspaceInputPaths(policy, inputDirectory).directory)).toBe(false)
        }),
      ),
    ),
  )

  it.effect("restores the repository snapshot before overlaying the seed archive", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-repository-" })
          const inputDirectory = `${root}/input`
          const workspace = `${root}/workspace`
          const repository = yield* repositoryArchive({
            root,
            files: { "repository.txt": "repository state", "shared.txt": "repository", "only-repository.txt": "repo" },
          })
          const seed = yield* seedArchive(root, {
            "seed.txt": "seed state",
            "shared.txt": "seed",
            "repository.txt": "seed repository state",
          })
          const json = policyJson({ checkout: checkoutJson(repository.commitSha), seed: seedPolicy(seed) })
          const policy = yield* decodePolicy(json)
          const paths = boxWorkspaceInputPaths(policy, inputDirectory)
          yield* writeParts(inputDirectory, policy, "repository", repository.archive.bytes)
          yield* writeParts(inputDirectory, policy, "seed", seed.bytes)

          const written: Array<string> = []
          const receipt = yield* materialize(
            documentJson(json, { repository: descriptor(repository.archive), seed: descriptor(seed) }),
            { inputDirectory, workspace },
            written,
          )

          expect(receipt.policyDigest).toBe(paths.policyDigest)
          expect(yield* printedReceipt(written)).toEqual(receipt)
          expect(yield* gitOutput(workspace, ["rev-parse", "HEAD"])).toBe(repository.commitSha)
          expect(yield* gitOutput(workspace, ["rev-parse", "--is-shallow-repository"])).toBe("true")
          expect(yield* fileSystem.readFileString(`${workspace}/repository.txt`)).toBe("seed repository state")
          expect(yield* fileSystem.readFileString(`${workspace}/seed.txt`)).toBe("seed state")
          expect(yield* fileSystem.readFileString(`${workspace}/shared.txt`)).toBe("seed")
          expect(yield* fileSystem.exists(`${workspace}/only-repository.txt`)).toBe(false)
          expect(yield* fileSystem.exists(`${workspace}/${workspaceInputReceiptRelativePath}`)).toBe(true)
          expect(yield* fileSystem.exists(paths.directory)).toBe(false)
        }),
      ),
    ),
  )

  it.effect("publishes an empty workspace when the policy declares no inputs", () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-workspace-input-empty-" })
          const inputDirectory = `${root}/input`
          const workspace = `${root}/workspace`
          const json = policyJson({})
          const policy = yield* decodePolicy(json)
          const paths = boxWorkspaceInputPaths(policy, inputDirectory)

          const written: Array<string> = []
          const receipt = yield* materialize(documentJson(json, {}), { inputDirectory, workspace }, written)

          expect(receipt.policyDigest).toBe(paths.policyDigest)
          expect(yield* fileSystem.readDirectory(workspace)).toEqual([".rika"])
          expect(yield* fileSystem.exists(`${workspace}/${workspaceInputReceiptRelativePath}`)).toBe(true)
        }),
      ),
    ),
  )
})
